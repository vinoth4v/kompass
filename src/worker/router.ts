// Chain resolution + provider dispatch, consulting the Durable Object for
// quota pre-skip, per-attempt reservation, health cooldowns and stickiness (M2).
//
// Streaming design (rewritten 2026-07-23): Kompass ALWAYS calls upstream
// providers non-streaming and buffers the complete answer server-side before
// ever writing a byte to the client. Once bytes are forwarded to Claude Code
// they can't be un-sent — a provider dying mid-generation used to become a
// client-visible in-stream error, and Claude Code does not reliably auto-retry
// that (observed live: sessions stopped and needed a manual "continue"). By
// resolving the full answer first, ANY failure (immediate or mid-generation)
// is invisible to the client and simply falls through to the next chain entry.
// The client-facing SSE stream (when the caller asked to stream) is synthesized
// from the complete, already-successful response via messageToAnthropicSSE.
import type { AnthropicRequest, AnthropicResponse, OpenAIResponse } from '../adapters/types';
import { anthropicToOpenAI, openAIToAnthropic } from '../adapters/openai';
import { anthropicToGemini, geminiToAnthropic, type GeminiResponse } from '../adapters/gemini';
import type { KompassState, FailureKind, ReserveLimits } from '../do/state';
import type { ProviderConfig, RouterConfig } from './config';
import { limitsFor, parseChainEntry, resolveLaneChain, resolveLaneSpreadTop } from './config';
import type { Env } from './env';

// Free-tier cold starts (NVIDIA especially) run past 60s — 90s covers that with room.
const TIMEOUT_MS = 90_000;

export interface RouteAttempt {
  entry: string;
  status: number | string;
  detail?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface RouteOutcome {
  response: Response | null;
  attempts: RouteAttempt[];
  used?: string;
}

export interface RouteContext {
  stub: DurableObjectStub<KompassState> | null;
  sessionId?: string;
  forced?: string;
  /** Request content matched the privacy guard → skip trains_on_data providers. */
  privacySensitive?: boolean;
  waitUntil: (p: Promise<unknown>) => void;
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

async function tryChainEntry(
  env: Env,
  cfg: RouterConfig,
  entry: string,
  body: AnthropicRequest,
  attempts: RouteAttempt[],
  privacySensitive = false,
  multimodal = false,
): Promise<Response | null> {
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
  // M5 privacy guard: sensitive content never reaches providers that train on inputs.
  if (privacySensitive && p.trains_on_data === true) {
    attempts.push({ entry, status: 'skipped-privacy', detail: 'trains_on_data provider' });
    return null;
  }
  // Image/PDF blocks: text-only providers silently ignore them and answer blind —
  // skip ahead to a provider whose models can actually read the attachment.
  if (multimodal && p.multimodal !== true) {
    attempts.push({ entry, status: 'skipped-multimodal', detail: 'text-only provider' });
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
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const upstream = await callUpstream(p, key, body, model, signal);

    if (!upstream.ok) {
      const errText = (await upstream.text()).slice(0, 300);
      attempts.push({ entry, status: upstream.status, detail: errText });
      return null;
    }

    const json = await upstream.json();
    const translated =
      p.kind === 'gemini'
        ? geminiToAnthropic(json as GeminiResponse, body.model)
        : openAIToAnthropic(json as OpenAIResponse, body.model);

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
      return new Response(messageToAnthropicSSE(translated), { headers: SSE_HEADERS });
    }
    return Response.json(translated);
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

  const limitsByEntry: Record<string, { key: string; limits: ReserveLimits }> = {};
  for (const entry of chain) {
    const { provider, model } = parseChainEntry(entry);
    const p = cfg.providers[provider];
    if (p)
      limitsByEntry[entry] = { key: counterKey(provider, model, p), limits: limitsFor(p, model) };
  }

  let order = chain;
  if (ctx.stub && !ctx.forced) {
    try {
      const plan = await ctx.stub.filterChain(chain, limitsByEntry, ctx.sessionId, spreadTop);
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
    );
    const last = attempts[attempts.length - 1];
    if (ctx.stub) {
      // Awaited (not waitUntil): a same-colo DO roundtrip is ~1ms and keeps
      // /status reads strictly consistent with the routes that produced them.
      await ctx.stub
        .reportOutcome(entry, res !== null, {
          kind: res === null && last ? failureKind(last.status) : undefined,
          sessionId: ctx.sessionId,
          lane,
          ms: Date.now() - t0,
          detail: res === null ? last?.detail?.slice(0, 120) : undefined,
          usage: last?.usage,
        })
        .catch((e) => console.log(`DO report failed: ${String(e)}`));
    }
    if (res) return { response: res, attempts, used: entry };
  }
  return { response: null, attempts };
}
