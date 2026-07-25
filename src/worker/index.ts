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
import {
  allChainEntries,
  CONFIG_KV_KEY,
  laneChainArray,
  laneOverrides,
  laneSpreadTop,
  limitsFor,
  loadConfig,
  resolveLaneChain,
  validateConfig,
} from './config';
import {
  digestOf,
  newTraceId,
  RAW_BODY_CAP,
  FULL_CAPTURE_TTL_MS,
  type TraceRecord,
} from '../do/trace';
import { dispatch, estimateTokens } from './dispatcher';
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
import { compactionConfig, compactRequest, type CompactionResult } from './compact';
import { compilePrivacyGuard, privacyMatch } from './privacy';
import { appliesToRequest, appliesToStrip, compileStrip, composeVoice, voiceConfig } from './voice';
import {
  deleteProviderKey,
  listProviderKeys,
  loadVaultKeys,
  putProviderKey,
  vaultAvailable,
} from './vault';
import { routeRequest, type RouteAttempt } from './router';
import { compileQualityPatterns, isCorrectiveTurn, PENALTY } from './score';
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
    // DELETE is required by the chat app's provider panel (remove a stored
    // key). Its absence made the browser's preflight fail while curl, which
    // sends no preflight, worked — so the button silently did nothing.
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'x-kompass-lane',
      'x-kompass-model',
      'x-kompass-trace',
    ],
    exposeHeaders: [
      'x-kompass-served-by',
      'x-kompass-lane',
      'x-kompass-trace-id',
      'x-kompass-compacted',
      'x-kompass-exhausted',
      'x-kompass-voice',
    ],
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

/**
 * Ceiling on real upstream attempts per request (Cloudflare error 1102), scaled
 * by request size.
 *
 * Every attempt holds a serialized copy of the request body while its fetch is
 * in flight, so the memory a single request can pin is roughly size × attempts
 * — and the isolate's 128MB is shared with every concurrent request. A flat 8
 * was still too generous for the big end: a ~180k-token session request
 * (Claude Code at 89% context) kept tipping isolates over even after the
 * payload cache landed. Small requests keep the full budget; the ones that
 * actually threaten the isolate get fewer swings.
 */
function attemptBudgetFor(estTokens: number): number {
  if (estTokens > 100_000) return 3;
  if (estTokens > 40_000) return 5;
  return 8;
}

/**
 * Marks the synthetic notices. They are 200 on purpose — Claude Code must see a
 * completed turn, not a protocol error — but that makes them indistinguishable
 * from a real answer to any other client. The AI Council was showing "Free lanes
 * are exhausted" as five agents' research findings because of exactly this.
 */
const EXHAUSTED_HEADER = { 'x-kompass-exhausted': 'true' };

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
  // Reassigned by server-side compaction below.
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

  // Server-side compaction (compact.ts) runs FIRST, so everything downstream —
  // the fit filter, token estimates, the payload cache, the attempt budget —
  // sees the reduced request. `raw` deliberately still describes the original
  // body: it is what the privacy guard scans and what the trace digest
  // identifies, and compaction must never shrink what gets security-checked.
  let compaction: CompactionResult | undefined;
  const cc = compactionConfig(cfg);
  if (cc) {
    const result = compactRequest(body, estimateTokens(body, raw.length), cc);
    if (result.truncated > 0) {
      compaction = result;
      body = result.body;
      console.log(
        JSON.stringify({
          compacted: { before: result.before, after: result.after, blocks: result.truncated },
        }),
      );
    }
  }

  // Everything that reasons about SIZE must use the post-compaction size, or a
  // request we just shrank would still be lane-classified and fit-filtered as
  // if it were huge. `raw` stays the original for the privacy scan and digest.
  const effectiveLength = compaction ? compaction.after * 4 : raw.length;

  const stub = stateStub(c.env);
  // A pinned lane (x-kompass-lane header or kompass-<lane> model name) skips the
  // dispatcher entirely — no classifier latency or quota for pre-routed traffic.
  const pinned = c.req.header('x-kompass-lane') ?? laneOverride;
  // M3 dispatcher: heuristics → cached/live classifier verdict → safe fallback.
  const verdict = pinned
    ? { lane: pinned, source: 'forced' as const, ms: 0 }
    : await dispatch(c.env, cfg, body, stub, effectiveLength);
  let lane = verdict.lane;

  // Claude Code stamps a stable per-session metadata.user_id — the stickiness key.
  const sessionId = body.metadata?.user_id;

  // M8 opt-in corrective-turn detection (off by default — SPEC_V2 §9): the
  // user's newest turn reads as "that was wrong" → attribute a quality
  // penalty to whichever model is (best-effort) still sticky for the
  // session, i.e. presumably the one that produced the turn being reacted
  // to. Runs BEFORE escalation below, which can release stickiness.
  if (sessionId && cfg.quality?.corrective_turn_detection) {
    try {
      const patterns = compileQualityPatterns(cfg);
      if (patterns.length && isCorrectiveTurn(body, patterns)) {
        const sticky = await stub.peekSticky(sessionId);
        if (sticky) {
          const pin = laneOverrides(cfg.lanes[sticky.lane] ?? cfg.lanes[cfg.default_lane])[
            sticky.entry
          ]?.pin;
          await stub
            .recordScorePenalty(sticky.lane, sticky.entry, PENALTY.corrective_turn, pin)
            .catch((e) => console.log(`score event failed: ${String(e)}`));
        }
      }
    } catch (e) {
      console.log(`corrective-turn detection unavailable: ${String(e)}`);
    }
  }

  // M5 escalation: ≥3 consecutive failed tool iterations → one lane up, stickiness released.
  let escalated = false;
  if (sessionId) {
    try {
      const errCount = await stub.bumpToolErrors(sessionId, lastTurnHadToolError(body));
      if (errCount >= ESCALATION_THRESHOLD) {
        const up = laneUp(lane);
        escalated = true;
        await stub.resetToolErrors(sessionId);
        // M8: attribute an escalation quality-penalty to whichever model was
        // serving the session when it started failing (SPEC_V2 §5) — uses the
        // released cell's OWN stored lane, not necessarily this request's
        // current `lane`, in case they've already diverged.
        const released = await stub.releaseSticky(sessionId);
        if (released) {
          const pin = laneOverrides(cfg.lanes[released.lane] ?? cfg.lanes[cfg.default_lane])[
            released.entry
          ]?.pin;
          await stub
            .recordScorePenalty(released.lane, released.entry, PENALTY.escalation, pin)
            .catch((e) => console.log(`score event failed: ${String(e)}`));
        }
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

  // Resolved once per request, not per chain attempt (see vault.ts).
  const vaultKeys = await loadVaultKeys(c.env, stub).catch((e) => {
    console.log(`vault unavailable: ${String(e).slice(0, 120)}`);
    return {} as Record<string, string>;
  });

  // ── House Voice ─────────────────────────────────────────────────────────
  // Applied AFTER the lane verdict (which carries the verbosity tier) and
  // BEFORE routing, so the composed system prompt and the max_tokens ceiling
  // are what every adapter translates. Coding clients are excluded by surface
  // and any tool-carrying turn is excluded outright — see appliesToRequest.
  const vcfg = voiceConfig(cfg);
  let voiceTier: string | undefined;
  let voiceStrip: ReturnType<typeof compileStrip> | undefined;
  if (
    vcfg &&
    appliesToRequest(vcfg, body, c.req.header(vcfg.apply_to?.header ?? 'x-kompass-surface'))
  ) {
    // A heuristic or forced lane produces no tier, so fall back to size: a
    // short question gets a short answer even when the classifier never ran.
    const tier =
      verdict.verbosity ?? (estimateTokens(body, effectiveLength) < 200 ? 'TERSE' : 'NORMAL');
    const composed = composeVoice(vcfg, body, tier);
    body = composed.body;
    voiceTier = composed.verbosity;
    console.log(JSON.stringify({ voice: { tier: voiceTier, max_tokens: composed.maxTokens } }));
  }

  const forcedModel = c.req.header('x-kompass-model') ?? undefined;
  // Error 1102: one shared ceiling on real upstream attempts for this request,
  // across the initial lane, every escalation hop and the last-resort sweep.
  // Before this, a single request could walk the entire roster (~40 entries)
  // and each attempt re-serialized a multi-MB body; isolates were being killed
  // during heavy sessions, which surfaces to Claude Code as a fatal 503 rather
  // than a turn it can recover from. Normal traffic resolves in 1-3 attempts,
  // so this only ever bites the pathological tail.
  const budget = {
    attemptsLeft: attemptBudgetFor(estimateTokens(body, effectiveLength)),
  };
  const routeOnce = (l: string, chainOverride?: string[]) =>
    routeRequest(c.env, cfg, l, body, {
      stub,
      sessionId,
      forced: forcedModel,
      privacySensitive,
      live,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      rawLength: effectiveLength,
      chainOverride,
      budget,
      vaultKeys,
      voiceStrip,
    });

  const allAttempts: RouteAttempt[] = [];
  let outcome = await routeOnce(lane);
  allAttempts.push(...outcome.attempts);
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
    allAttempts.push(...outcome.attempts);
    allTooLargeSoFar = allTooLargeSoFar && outcome.allSkippedTooLarge === true;
    if (
      outcome.largestCtx !== undefined &&
      (maxCtxSeen === undefined || outcome.largestCtx > maxCtxSeen)
    )
      maxCtxSeen = outcome.largestCtx;
  }

  // Last-resort pass (2026-07-25). The escalation ladder above only walks
  // FAST→SIMPLE→AGENTIC→HARD, so a lane outside it — LONGCTX — has no lane
  // "up" and used to give up the instant its own chain was spent. That is the
  // lane carrying the heaviest requests (>128k tokens) down the shortest chain
  // (4 entries, one of them the same model twice), so the terminal notice was
  // firing while models in other lanes could still have held the request.
  //
  // Rather than escalate LONGCTX *upward* (models above it are mostly SMALLER,
  // and would be dropped by the fit filter anyway), sweep every configured
  // entry not already tried on this request. The fit filter is what makes this
  // safe: entries too small for the request are skipped before dispatch, so a
  // huge request naturally reaches only the big-context models wherever they
  // happen to be declared. Quota, cooldowns, bans and the privacy guard all
  // still apply — this widens the candidate set, not the rules.
  let lastResort = false;
  if (!outcome.response && !forcedModel) {
    const tried = new Set(allAttempts.map((a) => a.entry));
    const remaining = allChainEntries(cfg).filter((e) => !tried.has(e));
    if (remaining.length > 0) {
      console.log(JSON.stringify({ last_resort: { lane, candidates: remaining.length } }));
      lastResort = true;
      outcome = await routeOnce(lane, remaining);
      allAttempts.push(...outcome.attempts);
      allTooLargeSoFar = allTooLargeSoFar && outcome.allSkippedTooLarge === true;
      if (
        outcome.largestCtx !== undefined &&
        (maxCtxSeen === undefined || outcome.largestCtx > maxCtxSeen)
      )
        maxCtxSeen = outcome.largestCtx;
    }
  }

  // M7 trace store (SPEC_V2 §5/§6, guardrail §6.13/§6.14): redacted by default,
  // fire-and-forget via ctx.waitUntil — a trace write NEVER blocks or fails the
  // response. `X-Kompass-Trace: full` opts this one request into a separate,
  // TTL-bounded copy of the raw body (see docs/DECISIONS.md for the storage design).
  const traceId = newTraceId();
  const fullCapture = c.req.header('x-kompass-trace')?.toLowerCase() === 'full';
  const digest = await digestOf(raw);
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  for (let i = allAttempts.length - 1; i >= 0; i--) {
    const a = allAttempts[i]!;
    if (a.status === 200 && a.usage) {
      usage = a.usage;
      break;
    }
  }
  const finish = (response: Response): Response => {
    const record: TraceRecord = {
      id: traceId,
      session: sessionId,
      ts: Date.now(),
      lane,
      verdict: verdict.source,
      confidence: verdict.confidence,
      est_in: estimateTokens(body, effectiveLength),
      chain_considered: resolveLaneChain(cfg, lane),
      attempts: allAttempts.map((a) => ({
        model: a.entry,
        outcome: a.status === 200 ? 'ok' : 'fail',
        hop_reason: String(a.status) + (a.detail ? `: ${a.detail}` : ''),
        latency_ms: a.ms,
      })),
      final_model: outcome.used,
      usage,
      digest,
    };
    if (fullCapture) {
      record.raw_body = raw.slice(0, RAW_BODY_CAP);
      record.exp = Date.now() + FULL_CAPTURE_TTL_MS;
    }
    c.executionCtx.waitUntil(
      stub.writeTrace(record).catch((e) => console.log(`trace write failed: ${String(e)}`)),
    );
    const headers = new Headers(response.headers);
    headers.set('x-kompass-trace-id', traceId);
    return new Response(response.body, { status: response.status, headers });
  };

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
        served_by_last_resort: lastResort || undefined,
      }),
    );
    // Provenance headers (2026-07-24): which provider/model actually served this
    // reply, and which lane it routed to — the native dialect's response body
    // otherwise only echoes back the requested model name, not what answered.
    // Exposed cross-origin via the CORS middleware's exposeHeaders.
    const headers = new Headers(outcome.response.headers);
    if (outcome.used) headers.set('x-kompass-served-by', outcome.used);
    headers.set('x-kompass-lane', lane);
    // Visible, not silent: a shortened context is something the user must be
    // able to see when judging an answer.
    if (compaction) {
      headers.set('x-kompass-compacted', `${compaction.before}->${compaction.after} tokens`);
    }
    // Visible so the shape of an answer is attributable — and so `kompass
    // voice` can measure compliance per model from real traffic.
    if (voiceTier) headers.set('x-kompass-voice', voiceTier);
    return finish(
      new Response(outcome.response.body, { status: outcome.response.status, headers }),
    );
  }
  console.log(JSON.stringify({ route: null, lane, attempts: outcome.attempts }));

  // M6 (SPEC_V2 §6 edge case): nothing was ever attempted anywhere — every lane's
  // every entry was too small for this request, not exhausted or unhealthy. Name
  // the largest window actually configured instead of the generic notice below.
  if (allTooLargeSoFar) {
    console.log(JSON.stringify({ no_fit: { largest_ctx: maxCtxSeen ?? null } }));
    if (body.stream) {
      return finish(
        new Response(noFitNoticeStream(body.model, maxCtxSeen), {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', ...EXHAUSTED_HEADER },
        }),
      );
    }
    return finish(c.json(noFitNotice(body.model, maxCtxSeen), 200, EXHAUSTED_HEADER));
  }

  // Every lane's entire chain failed. Always a friendly in-chat notice, never a
  // raw protocol error — Claude Code treats this as a normal completed turn, so
  // no manual retry/--continue is ever needed on Kompass's account (SPEC §4).
  if (body.stream) {
    return finish(
      new Response(syntheticNoticeStream(body.model), {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', ...EXHAUSTED_HEADER },
      }),
    );
  }
  return finish(c.json(syntheticNotice(body.model), 200, EXHAUSTED_HEADER));
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
  const stub = stateStub(c.env);
  const vaultKeys = await loadVaultKeys(c.env, stub).catch(() => ({}) as Record<string, string>);
  const outcome = await routeImageGeneration(c.env, cfg, body.prompt, stub, vaultKeys);
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
  const stub = stateStub(c.env);
  const vaultKeys = await loadVaultKeys(c.env, stub).catch(() => ({}) as Record<string, string>);
  const outcome = await routeEmbeddings(c.env, cfg, inputs, stub, vaultKeys);
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

// ── Provider key vault (src/worker/vault.ts) ────────────────────────────────
// Lets a browser-only user add provider keys with nothing installed. Behind the
// same auth gate as every other route. Responses are ALWAYS masked — no handler
// here ever returns key material, including the one that just stored it.

app.get('/keys', async (c) => {
  return c.json({
    vault_enabled: vaultAvailable(c.env),
    keys: await listProviderKeys(c.env, stateStub(c.env)),
  });
});

app.post('/keys/:provider', async (c) => {
  const provider = c.req.param('provider');
  const cfg = await loadConfig(c.env.CONFIG);
  if (cfg && !cfg.providers[provider]) {
    return anthropicError('invalid_request_error', `unknown provider "${provider}"`, 400);
  }
  let body: { key?: string };
  try {
    body = (await c.req.json()) as { key?: string };
  } catch {
    return anthropicError('invalid_request_error', 'body must be JSON', 400);
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return anthropicError('invalid_request_error', 'key (string) is required', 400);
  if (!vaultAvailable(c.env)) {
    return anthropicError(
      'api_error',
      'key vault disabled: KOMPASS_MASTER_KEY is not set on this Worker',
      503,
    );
  }
  try {
    const entry = await putProviderKey(c.env, stateStub(c.env), provider, key);
    // Masked in the log line too — a key must never reach logs intact.
    console.log(JSON.stringify({ vault_put: provider, masked: entry.masked }));
    return c.json({ ok: true, provider, masked: entry.masked, stored_at: entry.ts });
  } catch (e) {
    return anthropicError('api_error', String(e).slice(0, 200), 500);
  }
});

app.delete('/keys/:provider', async (c) => {
  await deleteProviderKey(stateStub(c.env), c.req.param('provider'));
  return c.json({ ok: true, provider: c.req.param('provider') });
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
    // The ledger keys a counter per MODEL whenever model_limits declares one
    // (counterKey() in router.ts), so reading snap.rpm/rpd[name] alone reported
    // a flat 0 for every provider that uses model_limits — which is most of
    // them. The token columns, keyed by bare provider name in recordUsage, kept
    // showing real traffic right next to "0 / 1.0k requests", making the whole
    // quota panel read as "nothing is being used" during a busy day (2026-07-25).
    // Sum every counter belonging to this provider, and expose the individual
    // counters too: per-model budgets are separate allowances, so the summed
    // figure answers "am I using this provider" while `counters` is what you
    // read before deciding a specific model has headroom left.
    const counters: Record<string, unknown> = {};
    let rpmUsed = 0;
    let rpdUsed = 0;
    const keys = [name, ...Object.keys(p.model_limits ?? {}).map((m) => `${name}:${m}`)];
    for (const key of keys) {
      const rm = snap.rpm[key]?.minute === minute ? snap.rpm[key].count : 0;
      const rd = snap.rpd[key]?.day === day ? snap.rpd[key].count : 0;
      rpmUsed += rm;
      rpdUsed += rd;
      // Unused counters are included too (2026-07-25). They were skipped, so
      // the dashboard could only ever show provider-wide limits — and those are
      // not the limits that bind: google's per-model ceilings range from 15/min
      // down to 20/DAY for gemini-3.6-flash. A model you have not called yet is
      // exactly the one whose budget you want to see before relying on it.
      const lim = key === name ? p.limits : limitsFor(p, key.slice(name.length + 1));
      counters[key] = { rpm: { used: rm, limit: lim.rpm }, rpd: { used: rd, limit: lim.rpd } };
    }
    const tok = snap.tokens[name]?.day === day ? snap.tokens[name] : undefined;
    providers[name] = {
      enabled: p.enabled !== false,
      // Vision-capable entries are seated in lanes as image/PDF fallbacks, not
      // for tool-heavy research. Exposed so clients (the AI Council planner)
      // can tell the difference — a vision model given a research brief
      // searched once and answered without reading anything.
      multimodal_models: p.multimodal_models ?? (p.multimodal === true ? ['*'] : []),
      // Surfaced for the chat app's Providers panel: `kind` distinguishes the
      // binding-backed provider (which needs no key at all) from HTTP ones, and
      // `key_env` is the exact Worker-secret name to set in the Cloudflare
      // dashboard — the path that works when the encrypted vault is disabled.
      kind: p.kind,
      key_env: p.key_env,
      has_key: Boolean((c.env as unknown as Record<string, string>)[p.key_env]),
      rpm: { used: rpmUsed, limit: p.limits.rpm },
      rpd: { used: rpdUsed, limit: p.limits.rpd },
      counters,
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
    // M8: adaptive quality score per "lane:entry" — health/quality/attempts/
    // demoted, backing spread-selection weighting (see src/worker/score.ts).
    scores: snap.scores,
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

// M7 trace store: single-record fetch (may include raw_body if that request
// opted into full capture and it hasn't expired yet) and a redacted-only
// recent-N listing. Both authenticated like every other non-health route.
app.get('/trace/:id', async (c) => {
  const trace = await stateStub(c.env).getTrace(c.req.param('id'));
  if (!trace) return anthropicError('not_found_error', 'no trace with that id', 404);
  return c.json(trace);
});

app.get('/traces', async (c) => {
  const n = Math.max(1, Math.min(500, Number(c.req.query('n')) || 50));
  return c.json({ traces: await stateStub(c.env).listTraces(n) });
});

// Admin: clear every model health cooldown. Recovery hatch for the case where a
// failure burst cools the ENTIRE roster at once and subsequent requests get the
// exhaustion notice without a single provider being tried. Quota counters are
// deliberately left alone.
app.post('/ledger/clear-cooldowns', async (c) => {
  const result = await stateStub(c.env).clearCooldowns();
  console.log(JSON.stringify({ cooldowns_cleared: result.cleared }));
  return c.json(result);
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

// Test/admin helper (M8): directly seed an entry's (lane, entry) adaptive
// score cell — bypasses the normal event-application flow.
app.post('/ledger/seed-score', async (c) => {
  const body = (await c.req.json()) as {
    lane?: string;
    entry?: string;
    health?: number;
    penalties?: number;
    attempts?: number;
    demoted?: boolean;
  };
  if (!body.lane || !body.entry) {
    return anthropicError('invalid_request_error', 'need {lane, entry, ...}', 400);
  }
  await stateStub(c.env).seedScore(body.lane, body.entry, {
    health: body.health,
    penalties: body.penalties,
    attempts: body.attempts,
    demoted: body.demoted,
  });
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
