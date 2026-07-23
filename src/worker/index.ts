import { Hono } from 'hono';
import type { AnthropicRequest } from '../adapters/types';
import { bearerAuth } from './auth';
import { getCloudflareUsage } from './cf-usage';
import { CONFIG_KV_KEY, laneChainArray, laneSpreadTop, loadConfig, validateConfig } from './config';
import { dispatch } from './dispatcher';
import { runDiscovery } from './discovery';
import type { Env } from './env';
import {
  ESCALATION_THRESHOLD,
  lastTurnHadToolError,
  laneUp,
  syntheticNotice,
  syntheticNoticeStream,
} from './escalation';
import { compilePrivacyGuard, privacyMatch } from './privacy';
import { routeRequest } from './router';
import { STATUS_HTML } from './status-page';

export { KompassState } from '../do/state';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true, service: 'kompass' }));

// Data-free static shell (like /healthz): the token is entered in-page and all
// data flows through the authenticated /status endpoint (DECISIONS.md).
app.get('/status.html', (c) => c.html(STATUS_HTML));

app.use('*', bearerAuth);

function anthropicError(type: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stateStub(env: Env) {
  return env.KOMPASS_STATE.get(env.KOMPASS_STATE.idFromName('global'));
}

app.post('/v1/messages', async (c) => {
  // Read the raw text ONCE and reuse it for token estimates and the privacy scan —
  // Claude Code contexts reach megabytes and repeated stringify passes were blowing
  // the free plan's ~10ms CPU budget (Cloudflare error 1102).
  const raw = await c.req.text();
  let body: AnthropicRequest;
  try {
    body = JSON.parse(raw) as AnthropicRequest;
  } catch {
    return anthropicError('invalid_request_error', 'body must be JSON', 400);
  }
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) {
    return anthropicError('api_error', 'no config in KV — run `kompass config push`', 503);
  }

  const stub = stateStub(c.env);
  // M3 dispatcher: heuristics → cached/live classifier verdict → safe fallback.
  const verdict = await dispatch(c.env, cfg, body, stub, raw.length);
  let lane = c.req.header('x-kompass-lane') ?? verdict.lane;

  // Claude Code stamps a stable per-session metadata.user_id — the stickiness key.
  const sessionId = body.metadata?.user_id;

  // M5 escalation: ≥3 consecutive failed tool iterations → one lane up, stickiness released.
  let escalated = false;
  if (sessionId) {
    try {
      const errCount = await stub.bumpToolErrors(sessionId, lastTurnHadToolError(body));
      if (errCount >= ESCALATION_THRESHOLD) {
        const up = laneUp(lane);
        escalated = true;
        await stub.resetToolErrors(sessionId);
        await stub.releaseSticky(sessionId);
        if (up && cfg.lanes[up]) {
          console.log(JSON.stringify({ escalate: { from: lane, to: up, session: sessionId } }));
          lane = up;
        } else if (lane === 'HARD' || !up) {
          // Already at the top — if HARD can't serve this request either, the
          // synthetic notice below tells the user to switch to native claude.
          console.log(JSON.stringify({ escalate: { from: lane, to: null } }));
        }
      }
    } catch (e) {
      console.log(`escalation state unavailable: ${String(e)}`);
    }
  }

  // M5 privacy guard: matched content never reaches trains_on_data providers.
  // Single combined-regex pass over the raw text; skipped entirely when no
  // configured provider trains on data.
  const anyTrainingProvider = Object.values(cfg.providers).some((p) => p.trains_on_data === true);
  const guard = anyTrainingProvider ? compilePrivacyGuard(cfg) : null;
  const privacySensitive = guard ? privacyMatch(guard, raw) : false;

  const outcome = await routeRequest(c.env, cfg, lane, body, {
    stub,
    sessionId,
    forced: c.req.header('x-kompass-model') ?? undefined,
    privacySensitive,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  if (outcome.response) {
    console.log(
      JSON.stringify({
        route: outcome.used,
        lane,
        dispatch: verdict.source,
        dispatch_ms: verdict.ms,
        attempts: outcome.attempts.length,
      }),
    );
    return outcome.response;
  }
  console.log(JSON.stringify({ route: null, lane, attempts: outcome.attempts }));

  // HARD exhausted → synthetic in-chat notice instead of an opaque 529 (SPEC §4).
  if (lane === 'HARD' || (escalated && !laneUp(lane))) {
    if (body.stream) {
      return new Response(syntheticNoticeStream(body.model), {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }
    return c.json(syntheticNotice(body.model));
  }
  return anthropicError(
    'overloaded_error',
    `all chain entries failed: ${outcome.attempts.map((a) => `${a.entry}→${a.status}`).join(', ')}`,
    529,
  );
});

app.post('/v1/messages/count_tokens', async (c) => {
  // Raw length ÷ 4 — no parse, no re-stringify (CPU budget, see /v1/messages).
  const raw = await c.req.text();
  return c.json({ input_tokens: Math.ceil(raw.length / 4) });
});

// Hot-reload: the CLI compiles config/*.yaml → JSON and POSTs it here (SPEC P0 #4).
app.post('/config', async (c) => {
  let candidate: unknown;
  try {
    candidate = await c.req.json();
  } catch {
    return anthropicError('invalid_request_error', 'config body must be JSON', 400);
  }
  try {
    validateConfig(candidate);
  } catch (e) {
    return anthropicError('invalid_request_error', `invalid config: ${String(e)}`, 400);
  }
  await c.env.CONFIG.put(CONFIG_KV_KEY, JSON.stringify(candidate));
  return c.json({ ok: true });
});

app.get('/config', async (c) => {
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) return anthropicError('not_found_error', 'no config pushed yet', 404);
  return c.json(cfg);
});

// Ledger + health view: per-provider remaining quota, cooldowns, last 50 routes (M4 CLI/status page).
app.get('/status', async (c) => {
  const cfg = await loadConfig(c.env.CONFIG);
  const snap = await stateStub(c.env).snapshot();
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const day = new Date(now).toISOString().slice(0, 10);

  const providers: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(cfg?.providers ?? {})) {
    const rpmUsed = snap.rpm[name]?.minute === minute ? snap.rpm[name].count : 0;
    const rpdUsed = snap.rpd[name]?.day === day ? snap.rpd[name].count : 0;
    const tok = snap.tokens[name]?.day === day ? snap.tokens[name] : undefined;
    providers[name] = {
      enabled: p.enabled !== false,
      has_key: Boolean((c.env as unknown as Record<string, string>)[p.key_env]),
      rpm: { used: rpmUsed, limit: p.limits.rpm },
      rpd: { used: rpdUsed, limit: p.limits.rpd },
      tokens_today: { in: tok?.tin ?? 0, out: tok?.tout ?? 0 },
    };
  }
  // Normalize lanes to a uniform {chain, spread_top} shape for clients — config
  // allows either a bare array or {chain, spread_top} per lane.
  const lanesOut: Record<string, { chain: string[]; spread_top: number }> = {};
  for (const [name, laneCfg] of Object.entries(cfg?.lanes ?? {})) {
    lanesOut[name] = { chain: laneChainArray(laneCfg), spread_top: laneSpreadTop(laneCfg, 1) };
  }
  // Per-entry reliability: success rate from recent outcomes (only entries with data).
  const perf = Object.fromEntries(
    Object.entries(snap.perf)
      .filter(([, v]) => v.ok + v.fail > 0)
      .map(([entry, v]) => [
        entry,
        { ok: v.ok, fail: v.fail, rate: Math.round((v.ok / (v.ok + v.fail)) * 100) },
      ]),
  );
  return c.json({
    lanes: lanesOut,
    default_lane: cfg?.default_lane,
    providers,
    perf,
    cooldowns: Object.fromEntries(
      Object.entries(snap.cooldowns).map(([k, v]) => [k, `${Math.round((v - now) / 1000)}s`]),
    ),
    routes: snap.routes.slice().reverse(),
    // Best-effort: null when CLOUDFLARE_API_TOKEN isn't set or the Analytics
    // API call fails — never blocks the rest of /status.
    cloudflare: await getCloudflareUsage(c.env),
  });
});

// Dispatcher dry-run: returns the lane verdict + added latency without routing.
// Backs the M3 acceptance measurement (p50 added latency < 400ms over 20 mixed requests).
app.post('/dispatch/preview', async (c) => {
  const raw = await c.req.text();
  const body = JSON.parse(raw) as AnthropicRequest;
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) return anthropicError('api_error', 'no config pushed yet', 503);
  return c.json(await dispatch(c.env, cfg, body, stateStub(c.env), raw.length));
});

// Test/admin helper backing the M2 multi-machine acceptance: burn provider budget.
app.post('/ledger/burn', async (c) => {
  const { provider, n } = (await c.req.json()) as { provider: string; n: number };
  if (!provider || typeof n !== 'number') {
    return anthropicError('invalid_request_error', 'need {provider, n}', 400);
  }
  return c.json(await stateStub(c.env).burn(provider, n));
});

// Test/admin helper: directly seed an entry's reliability score (bypasses cooldown).
app.post('/ledger/seed-perf', async (c) => {
  const { entry, ok, fail } = (await c.req.json()) as { entry: string; ok: number; fail: number };
  if (!entry || typeof ok !== 'number' || typeof fail !== 'number') {
    return anthropicError('invalid_request_error', 'need {entry, ok, fail}', 400);
  }
  await stateStub(c.env).seedPerf(entry, ok, fail);
  return c.json({ ok: true });
});

// Release a session's stickiness (used by tests; escalation uses it in M5).
app.post('/session/release', async (c) => {
  const { session_id } = (await c.req.json()) as { session_id: string };
  if (!session_id) return anthropicError('invalid_request_error', 'need {session_id}', 400);
  await stateStub(c.env).releaseSticky(session_id);
  return c.json({ ok: true });
});

// Scheduled model-discovery report (see discovery.ts + the daily Cron Trigger in
// wrangler.jsonc). Detect-only: never mutates config, just surfaces what's new.
app.get('/discovery', async (c) => {
  const report = await stateStub(c.env).getDiscovery();
  if (!report) return anthropicError('not_found_error', 'no discovery run yet', 404);
  return c.json(report);
});

// Manual trigger (the cron runs this automatically once a day).
app.post('/discovery/run', async (c) => {
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) return anthropicError('api_error', 'no config pushed yet', 503);
  return c.json(await runDiscovery(c.env, cfg, stateStub(c.env)));
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cfg = await loadConfig(env.CONFIG);
    if (!cfg) {
      console.log('scheduled discovery skipped: no config in KV');
      return;
    }
    ctx.waitUntil(runDiscovery(env, cfg, stateStub(env)));
  },
};
