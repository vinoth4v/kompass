import { Hono } from 'hono';
import type { AnthropicRequest } from '../adapters/types';
import { bearerAuth } from './auth';
import { CONFIG_KV_KEY, loadConfig, validateConfig } from './config';
import type { Env } from './env';
import { routeRequest } from './router';

export { KompassState } from '../do/state';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true, service: 'kompass' }));

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
  const body = (await c.req.json()) as AnthropicRequest;
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) {
    return anthropicError('api_error', 'no config in KV — run `kompass config push`', 503);
  }

  // Lane selection: M3 adds the dispatcher; until then everything rides the default lane.
  const lane = cfg.default_lane;

  const outcome = await routeRequest(c.env, cfg, lane, body, {
    stub: stateStub(c.env),
    // Claude Code stamps a stable per-session metadata.user_id — the stickiness key.
    sessionId: body.metadata?.user_id,
    forced: c.req.header('x-kompass-model') ?? undefined,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  if (outcome.response) {
    console.log(JSON.stringify({ route: outcome.used, lane, attempts: outcome.attempts.length }));
    return outcome.response;
  }
  console.log(JSON.stringify({ route: null, lane, attempts: outcome.attempts }));
  return anthropicError(
    'overloaded_error',
    `all chain entries failed: ${outcome.attempts.map((a) => `${a.entry}→${a.status}`).join(', ')}`,
    529,
  );
});

app.post('/v1/messages/count_tokens', async (c) => {
  const body = (await c.req.json()) as AnthropicRequest;
  const text = JSON.stringify(body.messages) + JSON.stringify(body.system ?? '');
  return c.json({ input_tokens: Math.ceil(text.length / 4) });
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
    providers[name] = {
      enabled: p.enabled !== false,
      has_key: Boolean((c.env as unknown as Record<string, string>)[p.key_env]),
      rpm: { used: rpmUsed, limit: p.limits.rpm },
      rpd: { used: rpdUsed, limit: p.limits.rpd },
    };
  }
  return c.json({
    lanes: cfg?.lanes ?? {},
    default_lane: cfg?.default_lane,
    providers,
    cooldowns: Object.fromEntries(
      Object.entries(snap.cooldowns).map(([k, v]) => [k, `${Math.round((v - now) / 1000)}s`]),
    ),
    routes: snap.routes.slice().reverse(),
  });
});

// Test/admin helper backing the M2 multi-machine acceptance: burn provider budget.
app.post('/ledger/burn', async (c) => {
  const { provider, n } = (await c.req.json()) as { provider: string; n: number };
  if (!provider || typeof n !== 'number') {
    return anthropicError('invalid_request_error', 'need {provider, n}', 400);
  }
  return c.json(await stateStub(c.env).burn(provider, n));
});

// Release a session's stickiness (used by tests; escalation uses it in M5).
app.post('/session/release', async (c) => {
  const { session_id } = (await c.req.json()) as { session_id: string };
  if (!session_id) return anthropicError('invalid_request_error', 'need {session_id}', 400);
  await stateStub(c.env).releaseSticky(session_id);
  return c.json({ ok: true });
});

export default app;
