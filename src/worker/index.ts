import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type { AnthropicRequest, AnthropicResponse } from '../adapters/types';
import {
  anthropicToChatResponse,
  anthropicToChatSSE,
  anthropicToResponsesResponse,
  anthropicToResponsesSSE,
  chatRequestToAnthropic,
  laneFromModel,
  responsesRequestToAnthropic,
  type ChatCompletionRequest,
  type ResponsesRequest,
} from '../adapters/ingress';
import { bearerAuth } from './auth';
import { routeEmbeddings, routeImageGeneration } from './capabilities';
import { getCloudflareUsage } from './cf-usage';
import { CONFIG_KV_KEY, laneChainArray, laneSpreadTop, loadConfig, validateConfig } from './config';
import { dispatch } from './dispatcher';
import { runDiscovery } from './discovery';
import type { Env } from './env';
import {
  ESCALATION_THRESHOLD,
  lastTurnHadToolError,
  laneUp,
  noFitNotice,
  noFitNoticeStream,
  syntheticNotice,
  syntheticNoticeStream,
} from './escalation';
import { compilePrivacyGuard, privacyMatch } from './privacy';
import { routeRequest } from './router';
import { FAVICON_SVG, STATUS_HTML } from './status-page';

export { KompassState } from '../do/state';

const app = new Hono<{ Bindings: Env }>();

// CORS (2026-07-24): lets a hosted client on a different origin (e.g. the
// Vercel-hosted chat app) call this Worker's API with just the bearer — no
// cookies involved, so a wildcard origin doesn't weaken auth (bearerAuth still
// gates every real endpoint). Registered first so it wraps every route,
// including the public health/favicon/status.html ones and — crucially — the
// 401 response bearerAuth returns for a bad token: without CORS headers on
// the error response too, a browser reports an opaque "CORS error" instead of
// a readable 401, which is what actually happens (Hono merges headers set
// here onto whatever Response a downstream handler returns — see Context#res).
// OPTIONS preflight is answered here directly, before bearerAuth ever runs.
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'x-kompass-lane',
      'x-kompass-model',
    ],
    exposeHeaders: ['x-kompass-served-by', 'x-kompass-lane'],
    maxAge: 86400,
  }),
);

app.get('/healthz', (c) => c.json({ ok: true, service: 'kompass' }));

// Data-free static shell (like /healthz): the token is entered in-page and all
// data flows through the authenticated /status endpoint (DECISIONS.md).
app.get('/status.html', (c) => c.html(STATUS_HTML));

// Logo/tab icon — data-free, so public like /healthz. Also answered at
// /favicon.ico for browsers that probe the default path.
const serveFavicon = (c: Context) =>
  c.body(FAVICON_SVG, 200, {
    'content-type': 'image/svg+xml',
    'cache-control': 'public, max-age=86400',
  });
app.get('/favicon.svg', serveFavicon);
app.get('/favicon.ico', serveFavicon);

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

/**
 * Shared routing core for every ingress dialect. Takes an Anthropic-shaped
 * request (native /v1/messages, or one translated from an OpenAI dialect in
 * ingress.ts), runs dispatch → route → cross-lane escalation, and returns the
 * final Anthropic-shaped Response. `raw` is the original request text, reused
 * for token estimates and the privacy scan (single-read CPU budget rule).
 */
async function handleAnthropic(
  c: Context<{ Bindings: Env }>,
  body: AnthropicRequest,
  raw: string,
  laneOverride?: string,
  // Native Claude Code dialect only: stream text deltas live (router.ts/live.ts).
  // The OpenAI-dialect ingresses need the complete buffered response to reshape.
  live = false,
): Promise<Response> {
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) {
    return anthropicError('api_error', 'no config in KV — run `kompass config push`', 503);
  }

  const stub = stateStub(c.env);
  // A pinned lane (x-kompass-lane header or kompass-<lane> model name) skips the
  // dispatcher entirely — no classifier latency or quota for pre-routed traffic.
  const pinned = c.req.header('x-kompass-lane') ?? laneOverride;
  // M3 dispatcher: heuristics → cached/live classifier verdict → safe fallback.
  const verdict = pinned
    ? { lane: pinned, source: 'forced' as const, ms: 0 }
    : await dispatch(c.env, cfg, body, stub, raw.length);
  let lane = verdict.lane;

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

  const forcedModel = c.req.header('x-kompass-model') ?? undefined;
  const routeOnce = (l: string) =>
    routeRequest(c.env, cfg, l, body, {
      stub,
      sessionId,
      forced: forcedModel,
      privacySensitive,
      live,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      rawLength: raw.length,
    });

  let outcome = await routeOnce(lane);
  // M6: track whether EVERY lane tried failed purely on fit (never actually
  // attempted a provider) — if so, the terminal notice below names the
  // largest configured window instead of the generic exhaustion message.
  let allTooLargeSoFar = outcome.allSkippedTooLarge === true;
  let maxCtxSeen = outcome.largestCtx;
  // Total exhaustion of one lane's chain doesn't mean every free model is down —
  // squeeze every remaining lane before ever giving up (skip when a specific
  // model was forced via x-kompass-model, e.g. smoke tests expecting exactly one).
  let escalatedOnExhaustion = false;
  while (!outcome.response && !forcedModel) {
    const up = laneUp(lane);
    if (!up || !cfg.lanes[up]) break;
    console.log(JSON.stringify({ escalate_on_exhaustion: { from: lane, to: up } }));
    lane = up;
    escalatedOnExhaustion = true;
    outcome = await routeOnce(lane);
    allTooLargeSoFar = allTooLargeSoFar && outcome.allSkippedTooLarge === true;
    if (
      outcome.largestCtx !== undefined &&
      (maxCtxSeen === undefined || outcome.largestCtx > maxCtxSeen)
    )
      maxCtxSeen = outcome.largestCtx;
  }

  if (outcome.response) {
    console.log(
      JSON.stringify({
        route: outcome.used,
        lane,
        dispatch: verdict.source,
        dispatch_ms: verdict.ms,
        attempts: outcome.attempts.length,
        escalated_on_tool_errors: escalated || undefined,
        escalated_on_exhaustion: escalatedOnExhaustion || undefined,
      }),
    );
    // Provenance headers (2026-07-24): which provider/model actually served this
    // reply, and which lane it routed to — the native dialect's response body
    // otherwise only echoes back the requested model name, not what answered.
    // Exposed cross-origin via the CORS middleware's exposeHeaders.
    const headers = new Headers(outcome.response.headers);
    if (outcome.used) headers.set('x-kompass-served-by', outcome.used);
    headers.set('x-kompass-lane', lane);
    return new Response(outcome.response.body, { status: outcome.response.status, headers });
  }
  console.log(JSON.stringify({ route: null, lane, attempts: outcome.attempts }));

  // M6 (SPEC_V2 §6 edge case): nothing was ever attempted anywhere — every lane's
  // every entry was too small for this request, not exhausted or unhealthy. Name
  // the largest window actually configured instead of the generic notice below.
  if (allTooLargeSoFar) {
    console.log(JSON.stringify({ no_fit: { largest_ctx: maxCtxSeen ?? null } }));
    if (body.stream) {
      return new Response(noFitNoticeStream(body.model, maxCtxSeen), {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }
    return c.json(noFitNotice(body.model, maxCtxSeen));
  }

  // Every lane's entire chain failed. Always a friendly in-chat notice, never a
  // raw protocol error — Claude Code treats this as a normal completed turn, so
  // no manual retry/--continue is ever needed on Kompass's account (SPEC §4).
  if (body.stream) {
    return new Response(syntheticNoticeStream(body.model), {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }
  return c.json(syntheticNotice(body.model));
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
  // kompass-<lane> model names pin the lane on the native dialect too (the
  // OpenAI-dialect ingresses below already do this via routeTranslated).
  return handleAnthropic(c, body, raw, laneFromModel(body.model), true);
});

// ---- OpenAI-compatible ingress (Cursor, Cline, Roo Code, Continue, Aider …) ----

function openaiError(message: string, status: number): Response {
  return Response.json({ error: { message, type: 'api_error', code: null } }, { status });
}

/** Run a translated Anthropic request through the core and give back the parsed
 *  AnthropicResponse (always non-streaming internally — see router.ts), or the
 *  error Response as-is for the caller to reshape. */
async function routeTranslated(
  c: Context<{ Bindings: Env }>,
  anth: AnthropicRequest,
  raw: string,
  lane: string | undefined,
): Promise<AnthropicResponse | Response> {
  const res = await handleAnthropic(c, anth, raw, lane);
  if (!res.ok) return res;
  return (await res.json()) as AnthropicResponse;
}

const SSE_OUT = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' };

app.post('/v1/chat/completions', async (c) => {
  const raw = await c.req.text();
  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(raw) as ChatCompletionRequest;
  } catch {
    return openaiError('body must be JSON', 400);
  }
  const model = body.model ?? 'kompass';
  const result = await routeTranslated(c, chatRequestToAnthropic(body), raw, laneFromModel(model));
  if (result instanceof Response) {
    return openaiError(`kompass: ${(await result.text()).slice(0, 300)}`, result.status);
  }
  if (body.stream) {
    return new Response(
      anthropicToChatSSE(result, model, body.stream_options?.include_usage === true),
      { headers: SSE_OUT },
    );
  }
  return c.json(anthropicToChatResponse(result, model));
});

app.post('/v1/responses', async (c) => {
  const raw = await c.req.text();
  let body: ResponsesRequest;
  try {
    body = JSON.parse(raw) as ResponsesRequest;
  } catch {
    return openaiError('body must be JSON', 400);
  }
  const model = body.model ?? 'kompass';
  const result = await routeTranslated(
    c,
    responsesRequestToAnthropic(body),
    raw,
    laneFromModel(model),
  );
  if (result instanceof Response) {
    return openaiError(`kompass: ${(await result.text()).slice(0, 300)}`, result.status);
  }
  if (body.stream) {
    return new Response(anthropicToResponsesSSE(result, model), { headers: SSE_OUT });
  }
  return c.json(anthropicToResponsesResponse(result, model));
});

// ---- Non-chat capabilities: image generation + embeddings (free models) ----

// OpenAI Images API-compatible: {prompt, model?, n?} → {created, data:[{b64_json}]}.
// One image per request (n is ignored — every generation burns free-tier budget);
// the chain lives in config `images.chain` and meters the same DO ledger.
app.post('/v1/images/generations', async (c) => {
  let body: { prompt?: string };
  try {
    body = (await c.req.json()) as { prompt?: string };
  } catch {
    return openaiError('body must be JSON', 400);
  }
  if (!body.prompt || typeof body.prompt !== 'string') {
    return openaiError('prompt (string) is required', 400);
  }
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) return openaiError('no config in KV — run `kompass config push`', 503);
  if (!cfg.images?.chain?.length) {
    return openaiError('image generation not configured (images.chain in lanes.yaml)', 501);
  }
  const outcome = await routeImageGeneration(c.env, cfg, body.prompt, stateStub(c.env));
  console.log(JSON.stringify({ images: outcome.used ?? null, attempts: outcome.attempts.length }));
  if (!outcome.result) {
    return openaiError(
      `all image models failed: ${outcome.attempts.map((a) => `${a.entry} ${a.status}`).join('; ')}`,
      502,
    );
  }
  return c.json({
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: outcome.result.b64 }],
    // Kompass extensions (harmless to OpenAI clients): what served it + media type.
    model: outcome.used,
    mime_type: outcome.result.mime,
  });
});

// OpenAI Embeddings API-compatible: {input: string|string[]} → {object:"list", data:[...]}.
// Chain lives in config `embeddings.chain`; vector dimensions depend on the
// serving model, so pin one entry if your vector store needs stable dims.
app.post('/v1/embeddings', async (c) => {
  let body: { input?: string | string[] };
  try {
    body = (await c.req.json()) as { input?: string | string[] };
  } catch {
    return openaiError('body must be JSON', 400);
  }
  const inputs =
    typeof body.input === 'string' ? [body.input] : Array.isArray(body.input) ? body.input : null;
  if (!inputs || inputs.length === 0 || inputs.some((i) => typeof i !== 'string')) {
    return openaiError('input (string or string[]) is required', 400);
  }
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) return openaiError('no config in KV — run `kompass config push`', 503);
  if (!cfg.embeddings?.chain?.length) {
    return openaiError('embeddings not configured (embeddings.chain in lanes.yaml)', 501);
  }
  const outcome = await routeEmbeddings(c.env, cfg, inputs, stateStub(c.env));
  console.log(
    JSON.stringify({ embeddings: outcome.used ?? null, attempts: outcome.attempts.length }),
  );
  if (!outcome.result) {
    return openaiError(
      `all embedding models failed: ${outcome.attempts.map((a) => `${a.entry} ${a.status}`).join('; ')}`,
      502,
    );
  }
  return c.json({
    object: 'list',
    data: outcome.result.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: outcome.used,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
});

// Model roster for client pickers/validation (Cursor and others call this).
app.get('/v1/models', (c) => {
  const ids = [
    'kompass',
    'kompass-fast',
    'kompass-simple',
    'kompass-agentic',
    'kompass-hard',
    'kompass-longctx',
  ];
  return c.json({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'kompass' })),
  });
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
    // Daily aggregates (HISTORY_DAYS retention in the DO) — the analytics tab
    // computes daily/monthly consumption and model usage from these client-side.
    history: snap.history,
    // Best-effort: null when CLOUDFLARE_API_TOKEN isn't set or the Analytics
    // API call fails — never blocks the rest of /status.
    cloudflare: await getCloudflareUsage(c.env),
    deprecated_models: cfg?.deprecated_models ?? {},
    // User-toggled off via `kompass models disable` — still listed in lanes.yaml,
    // never tried until re-enabled. Surfaced so the dashboard can mark them.
    disabled_models: cfg?.disabled_models ?? [],
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
