// Chain resolution + provider dispatch, consulting the Durable Object for
// quota pre-skip, per-attempt reservation, health cooldowns and stickiness (M2).
//
// Streaming design (hybrid since 2026-07-23, see live.ts): for the native
// Claude Code dialect with stream:true, upstream is called streaming and text
// deltas are forwarded live — but only after the first content token, so any
// failure before that (bad status, garbled body, timeout, empty stream) still
// falls through to the next chain entry invisibly. A provider dying after
// text has been forwarded is closed out gracefully (a valid, short-but-
// completed turn — never a protocol error needing a manual "continue").
//
// Every other path — non-streaming clients, the OpenAI-dialect ingresses, and
// pure tool-call turns — keeps the original buffer-then-emit behavior: the
// complete answer is resolved server-side first and the client-facing SSE
// stream (when asked for) is synthesized via messageToAnthropicSSE.
import type { AnthropicRequest, AnthropicResponse, OpenAIResponse } from '../adapters/types';
import { anthropicToOpenAI, openAIToAnthropic } from '../adapters/openai';
import { anthropicToGemini, geminiToAnthropic, type GeminiResponse } from '../adapters/gemini';
import type { KompassState, FailureKind, ReserveLimits } from '../do/state';
import type { ProviderConfig, RouterConfig } from './config';
import {
  isModelDisabled,
  limitsFor,
  parseChainEntry,
  resolveLaneChain,
  resolveLaneSpreadTop,
} from './config';
import type { Env } from './env';
import { filterChainByFit, largestCtx as fitLargestCtx, recordActualTokens } from './fit';
import { tryLiveEntry, type LiveUsage } from './live';

// Free-tier cold starts (NVIDIA especially) run past 60s — 90s covers that with room.
const TIMEOUT_MS = 90_000;

export interface RouteAttempt {
  entry: string;
  status: number | string;
  detail?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Wall-clock ms for this entry's attempt (reserve + upstream call). Undefined
   *  for entries skipped before ever being tried (fit filter, quota, disabled…) —
   *  populated by routeRequest's main loop, used by the M7 trace store. */
  ms?: number;
}

export interface RouteOutcome {
  response: Response | null;
  attempts: RouteAttempt[];
  used?: string;
  /** M6: this lane had chain entries, but the fit filter dropped every one of
   *  them (skipped-too-large) — none were even attempted against the ledger or
   *  a provider. Lets the caller (index.ts) emit the "fits nothing" notice
   *  instead of the generic exhaustion one when this holds across every lane. */
  allSkippedTooLarge?: boolean;
  /** Largest ctx declared anywhere in this lane's chain, for that notice. */
  largestCtx?: number;
}

export interface RouteContext {
  stub: DurableObjectStub<KompassState> | null;
  sessionId?: string;
  forced?: string;
  /** Request content matched the privacy guard → skip trains_on_data providers. */
  privacySensitive?: boolean;
  /** Native Anthropic dialect: stream text deltas live (see live.ts). */
  live?: boolean;
  waitUntil: (p: Promise<unknown>) => void;
  /** Raw request body length, captured once at ingress (never re-serialize —
   *  CPU budget). Feeds the M6 fit filter's byte→token estimate. */
  rawLength?: number;
}

function providerKey(env: Env, p: ProviderConfig): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[p.key_env];
}

/** Ledger counter key: per provider, or per provider:model when model_limits applies. */
export function counterKey(provider: string, model: string, p: ProviderConfig): string {
  return p.model_limits?.[model] ? `${provider}:${model}` : provider;
}

/** Always requests a plain (non-streaming) upstream response — see file header. */
function callUpstream(
  p: ProviderConfig,
  key: string,
  body: AnthropicRequest,
  model: string,
  signal: AbortSignal,
): Promise<Response> {
  const nonStreamBody: AnthropicRequest = { ...body, stream: false };
  if (p.kind === 'gemini') {
    return fetch(`${p.base_url}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(anthropicToGemini(nonStreamBody)),
      signal,
    });
  }
  return fetch(`${p.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'http-referer': 'https://github.com/vinoth4v/kompass',
      'x-title': 'Kompass',
    },
    body: JSON.stringify(anthropicToOpenAI(nonStreamBody, model)),
    signal,
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Synthesize a well-formed Anthropic SSE stream from a COMPLETE message. Used
 * both for real routed responses (when the client asked to stream) and for
 * synthetic notices (escalation.ts). One content_block per block, emitted
 * whole — no incremental pacing, since by construction the answer is already
 * fully known; the client sees it arrive as fast as one response body allows.
 */
export function messageToAnthropicSSE(msg: AnthropicResponse): string {
  let out = sseEvent('message_start', {
    type: 'message_start',
    message: { ...msg, content: [], stop_reason: null },
  });
  msg.content.forEach((block, index) => {
    const content_block =
      block.type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: block.id, name: block.name, input: {} };
    out += sseEvent('content_block_start', { type: 'content_block_start', index, content_block });
    const delta =
      block.type === 'text'
        ? { type: 'text_delta', text: block.text }
        : { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) };
    out += sseEvent('content_block_delta', { type: 'content_block_delta', index, delta });
    out += sseEvent('content_block_stop', { type: 'content_block_stop', index });
  });
  out += sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  out += sseEvent('message_stop', { type: 'message_stop' });
  return out;
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
};

function failureKind(status: number | string): FailureKind {
  if (status === 429) return '429';
  if (status === 'timeout') return 'timeout';
  if (typeof status === 'number') return '5xx';
  return 'stream-error';
}

/** True when any message carries an image/document block — needs a multimodal model. */
export function hasMultimodalBlocks(body: AnthropicRequest): boolean {
  for (const m of body.messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'image' || b.type === 'document') return true;
    }
  }
  return false;
}

interface EntrySuccess {
  response: Response;
  /** Live streams only: usage becomes known when the stream ends. */
  usageLater?: Promise<LiveUsage>;
}

async function tryChainEntry(
  env: Env,
  cfg: RouterConfig,
  entry: string,
  body: AnthropicRequest,
  attempts: RouteAttempt[],
  privacySensitive = false,
  multimodal = false,
  live = false,
): Promise<EntrySuccess | null> {
  const { provider, model } = parseChainEntry(entry);
  const p = cfg.providers[provider];
  if (!p) {
    attempts.push({ entry, status: 'error', detail: 'unknown provider' });
    return null;
  }
  if (p.enabled === false) {
    attempts.push({ entry, status: 'skipped-disabled' });
    return null;
  }
  // User-toggled off via `kompass models disable` — kept in the chain (so lanes.yaml
  // stays a readable record of the full roster) but never tried until re-enabled.
  if (isModelDisabled(cfg, entry)) {
    attempts.push({ entry, status: 'skipped-disabled-model' });
    return null;
  }
  // M5 privacy guard: sensitive content never reaches providers that train on inputs.
  if (privacySensitive && p.trains_on_data === true) {
    attempts.push({ entry, status: 'skipped-privacy', detail: 'trains_on_data provider' });
    return null;
  }
  // Image/PDF blocks: text-only models silently ignore them and answer blind —
  // skip ahead to a model that can actually read the attachment. Capability is
  // provider-wide (multimodal: true) or per-model (multimodal_models list).
  if (multimodal && p.multimodal !== true && !p.multimodal_models?.includes(model)) {
    attempts.push({ entry, status: 'skipped-multimodal', detail: 'text-only model' });
    return null;
  }
  const key = providerKey(env, p);
  if (!key) {
    attempts.push({ entry, status: 'skipped-no-key' });
    return null;
  }
  // Guardrail §6.8, enforced at request time as well as config-validation time.
  if (!cfg.allow_paid && provider === 'openrouter' && !model.endsWith(':free')) {
    attempts.push({ entry, status: 'error', detail: 'paid model blocked (allow_paid=false)' });
    return null;
  }

  try {
    let translated: AnthropicResponse | null = null;

    if (live && body.stream === true) {
      const r = await tryLiveEntry(p, key, body, model);
      if (r.kind === 'live') {
        attempts.push({ entry, status: 200 });
        return { response: r.response, usageLater: r.done };
      }
      if (r.kind === 'complete') {
        translated = r.message;
      } else if (r.kind === 'json') {
        translated =
          p.kind === 'gemini'
            ? geminiToAnthropic(r.json as GeminiResponse, body.model)
            : openAIToAnthropic(r.json as OpenAIResponse, body.model);
      } else {
        // A non-429 4xx may just mean "this provider rejects streaming
        // requests" — retry the same entry buffered before giving up on it.
        const retryBuffered = typeof r.status === 'number' && r.status >= 400 && r.status < 429;
        attempts.push({
          entry,
          status: retryBuffered ? `live-${r.status}` : r.status,
          detail: r.detail,
        });
        if (!retryBuffered) return null;
      }
    }

    if (!translated) {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const upstream = await callUpstream(p, key, body, model, signal);

      if (!upstream.ok) {
        const errText = (await upstream.text()).slice(0, 300);
        attempts.push({ entry, status: upstream.status, detail: errText });
        return null;
      }

      const json = await upstream.json();
      translated =
        p.kind === 'gemini'
          ? geminiToAnthropic(json as GeminiResponse, body.model)
          : openAIToAnthropic(json as OpenAIResponse, body.model);
    }

    // The original dataforge-local bug: a provider can return 200 with a
    // technically-valid but empty completion (no text, no tool_use). Treat
    // that as a failure too — fall through to the next entry — instead of
    // handing Claude Code a finished-looking turn with nothing in it.
    if (translated.content.length === 0) {
      attempts.push({ entry, status: 'error', detail: 'empty response (no content blocks)' });
      return null;
    }

    attempts.push({ entry, status: 200, usage: translated.usage });

    if (body.stream) {
      return {
        response: new Response(messageToAnthropicSSE(translated), { headers: SSE_HEADERS }),
      };
    }
    return { response: Response.json(translated) };
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    attempts.push({
      entry,
      status: timedOut ? 'timeout' : 'error',
      detail: String(e).slice(0, 200),
    });
    return null;
  }
}

/**
 * Route a request down a lane's chain: DO-filtered order (sticky first, exhausted
 * and cooling entries pre-skipped), per-attempt quota reservation, outcome reports.
 */
export async function routeRequest(
  env: Env,
  cfg: RouterConfig,
  lane: string,
  body: AnthropicRequest,
  ctx: RouteContext,
): Promise<RouteOutcome> {
  const chain = ctx.forced ? [ctx.forced] : resolveLaneChain(cfg, lane);
  const spreadTop = ctx.forced ? 1 : resolveLaneSpreadTop(cfg, lane);
  const attempts: RouteAttempt[] = [];
  const multimodal = hasMultimodalBlocks(body);
  // M6: request size captured once at ingress (ctx.rawLength) — reused here for
  // both the fit filter and the post-response calibration hook. Falls back to a
  // stringify only for callers without raw text (unit tests) — never on the hot
  // path (index.ts always sets rawLength).
  const estBytes = ctx.rawLength ?? JSON.stringify(body).length;

  // M6 fit filter: runs AFTER the privacy guard (privacySensitive is already
  // decided by the caller) and BEFORE the quota ledger below — a chain entry
  // this request structurally cannot hold is dropped before it ever consumes a
  // reservation. Skipped when a specific entry is forced (smoke tests, etc.).
  let fitChain = chain;
  let allSkippedTooLarge = false;
  let laneLargestCtx: number | undefined;
  if (!ctx.forced) {
    const fit = filterChainByFit(cfg, chain, estBytes, body.max_tokens);
    fitChain = fit.order;
    for (const s of fit.skipped)
      attempts.push({ entry: s.entry, status: 'skipped-too-large', detail: s.detail });
    allSkippedTooLarge = chain.length > 0 && fitChain.length === 0;
    laneLargestCtx = fitLargestCtx(cfg, chain);
  }

  const limitsByEntry: Record<string, { key: string; limits: ReserveLimits }> = {};
  for (const entry of fitChain) {
    const { provider, model } = parseChainEntry(entry);
    const p = cfg.providers[provider];
    if (p)
      limitsByEntry[entry] = { key: counterKey(provider, model, p), limits: limitsFor(p, model) };
  }

  let order = fitChain;
  if (ctx.stub && !ctx.forced) {
    try {
      const plan = await ctx.stub.filterChain(fitChain, limitsByEntry, ctx.sessionId, spreadTop);
      order = plan.order;
      for (const s of plan.skipped)
        attempts.push({ entry: s.entry, status: `skipped-${s.reason}` });
    } catch (e) {
      console.log(`DO filterChain failed, using raw chain: ${String(e)}`);
    }
  }

  for (const entry of order) {
    const t0 = Date.now();
    const cell = limitsByEntry[entry];
    if (ctx.stub && cell) {
      try {
        const r = await ctx.stub.reserve(cell.key, cell.limits);
        if (!r.ok) {
          attempts.push({ entry, status: `skipped-${r.reason} exhausted` });
          continue;
        }
      } catch (e) {
        console.log(`DO reserve failed, proceeding unmetered: ${String(e)}`);
      }
    }
    const res = await tryChainEntry(
      env,
      cfg,
      entry,
      body,
      attempts,
      ctx.privacySensitive,
      multimodal,
      ctx.live === true,
    );
    const last = attempts[attempts.length - 1];
    // M7: latency for this entry's own attempt, attached for the trace store —
    // reserve() + tryChainEntry() together, matching what reportOutcome logs below.
    if (last) last.ms = Date.now() - t0;
    if (ctx.stub) {
      // Awaited (not waitUntil): a same-colo DO roundtrip is ~1ms and keeps
      // /status reads strictly consistent with the routes that produced them.
      await ctx.stub
        .reportOutcome(entry, res !== null, {
          kind: res === null && last ? failureKind(last.status) : undefined,
          sessionId: ctx.sessionId,
          lane,
          ms: last?.ms ?? Date.now() - t0,
          detail: res === null ? last?.detail?.slice(0, 120) : undefined,
          usage: last?.usage,
        })
        .catch((e) => console.log(`DO report failed: ${String(e)}`));
    }
    if (res) {
      // M6 calibration: correct this provider's byte→token ratio from what the
      // request actually cost, off the response path — never blocks the reply.
      const { provider } = parseChainEntry(entry);
      const stub = ctx.stub;
      if (res.usageLater) {
        // Live streams learn their token counts only at stream end — patch the
        // ledger and the routes log after the fact, off the response path.
        ctx.waitUntil(
          res.usageLater
            .then((u) => {
              recordActualTokens(provider, estBytes, u.input_tokens);
              return stub?.recordUsage(entry, u);
            })
            .catch((e) => console.log(`DO recordUsage failed: ${String(e)}`)),
        );
      } else if (last?.usage) {
        recordActualTokens(provider, estBytes, last.usage.input_tokens);
      }
      return { response: res.response, attempts, used: entry };
    }
  }
  return { response: null, attempts, allSkippedTooLarge, largestCtx: laneLargestCtx };
}
