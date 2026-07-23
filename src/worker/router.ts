// Chain resolution + provider dispatch, consulting the Durable Object for
// quota pre-skip, per-attempt reservation, health cooldowns and stickiness (M2).
import type { AnthropicRequest, OpenAIResponse } from '../adapters/types';
import {
  anthropicToOpenAI,
  openAIStreamToAnthropicStream,
  openAIToAnthropic,
} from '../adapters/openai';
import {
  anthropicToGemini,
  geminiStreamToAnthropicStream,
  geminiToAnthropic,
  type GeminiResponse,
} from '../adapters/gemini';
import type { KompassState, FailureKind, ReserveLimits } from '../do/state';
import type { ProviderConfig, RouterConfig } from './config';
import { limitsFor, parseChainEntry } from './config';
import type { Env } from './env';

// First-byte timeout: NVIDIA free-tier cold starts run past 60s, so 75s for streams
// (headers) and 90s total for non-streaming bodies. After first byte, no timeout —
// long agentic streams are legitimate.
const HEADERS_TIMEOUT_MS = 75_000;
const FIRST_CHUNK_TIMEOUT_MS = 60_000;
const NONSTREAM_TIMEOUT_MS = 90_000;

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

function callUpstream(
  p: ProviderConfig,
  key: string,
  body: AnthropicRequest,
  model: string,
  signal: AbortSignal,
): Promise<Response> {
  if (p.kind === 'gemini') {
    const verb = body.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return fetch(`${p.base_url}/models/${model}:${verb}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(anthropicToGemini(body)),
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
    body: JSON.stringify(anthropicToOpenAI(body, model)),
    signal,
  });
}

/** Does this SSE data payload carry actual model output? */
function frameHasContent(payload: string, kind: 'openai' | 'gemini'): boolean | 'error' {
  try {
    const j = JSON.parse(payload);
    if (j.error) return 'error';
    if (kind === 'gemini') {
      const parts = j.candidates?.[0]?.content?.parts;
      return Array.isArray(parts) && parts.length > 0;
    }
    const d = j.choices?.[0]?.delta;
    return Boolean(
      d && (d.content || d.reasoning || d.reasoning_content || (d.tool_calls?.length ?? 0) > 0),
    );
  } catch {
    return false;
  }
}

/**
 * Commit to a provider's stream only once it produces a *content* frame — a 200
 * whose stream dies, errors, or ends empty before any content falls through to the
 * next model instead of reaching the client as a "finished" empty assistant turn
 * (observed live: Claude Code sessions silently stopping on 0-token responses).
 * After content starts, mid-stream death closes gracefully (the SSE transform's
 * flush emits message_delta/message_stop) and `onMidStreamError` lets the caller
 * cool the model down + break stickiness so the next turn re-routes.
 */
export async function gateStreamOnContent(
  body: ReadableStream<Uint8Array>,
  kind: 'openai' | 'gemini',
  timeoutMs = FIRST_CHUNK_TIMEOUT_MS,
  onMidStreamError?: () => void,
): Promise<ReadableStream<Uint8Array> | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let text = '';
  let lineStart = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    scan: for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('no content before timeout');
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no content before timeout')), remaining),
        ),
      ]);
      if (next.done) {
        console.log('upstream stream ended with no content — failing over');
        return null;
      }
      buffered.push(next.value);
      text += decoder.decode(next.value, { stream: true });
      let idx: number;
      while ((idx = text.indexOf('\n', lineStart)) !== -1) {
        const line = text.slice(lineStart, idx).replace(/\r$/, '');
        lineStart = idx + 1;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          console.log('upstream sent [DONE] before any content — failing over');
          return null;
        }
        const has = frameHasContent(payload, kind);
        if (has === 'error') {
          console.log(`upstream in-stream error frame: ${payload.slice(0, 200)} — failing over`);
          return null;
        }
        if (has) break scan;
      }
    }
  } catch (e) {
    console.log(`upstream content-gate failure: ${String(e)}`);
    reader.cancel().catch(() => {});
    return null;
  }

  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull: async (c) => {
      if (i < buffered.length) {
        c.enqueue(buffered[i++]!);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      } catch (e) {
        console.log(`upstream mid-stream error (graceful close): ${String(e)}`);
        onMidStreamError?.();
        c.close();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
};

function failureKind(status: number | string): FailureKind {
  if (status === 429) return '429';
  if (status === 'timeout' || status === 'first-chunk') return 'timeout';
  if (typeof status === 'number') return '5xx';
  return 'stream-error';
}

async function tryChainEntry(
  env: Env,
  cfg: RouterConfig,
  entry: string,
  body: AnthropicRequest,
  attempts: RouteAttempt[],
  privacySensitive = false,
  onStreamUsage?: (usage: { input_tokens: number; output_tokens: number }) => void,
  onMidStreamError?: () => void,
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
    const signal = AbortSignal.timeout(body.stream ? HEADERS_TIMEOUT_MS : NONSTREAM_TIMEOUT_MS);
    const upstream = await callUpstream(p, key, body, model, signal);

    if (!upstream.ok) {
      const errText = (await upstream.text()).slice(0, 300);
      attempts.push({ entry, status: upstream.status, detail: errText });
      return null;
    }

    if (body.stream) {
      if (!upstream.body) {
        attempts.push({ entry, status: 'error', detail: 'no body' });
        return null;
      }
      const gated = await gateStreamOnContent(
        upstream.body,
        p.kind,
        FIRST_CHUNK_TIMEOUT_MS,
        onMidStreamError,
      );
      if (!gated) {
        attempts.push({ entry, status: 'first-chunk', detail: 'no content before timeout/EOF' });
        return null;
      }
      const stream =
        p.kind === 'gemini'
          ? geminiStreamToAnthropicStream(gated, body.model, onStreamUsage, onMidStreamError)
          : openAIStreamToAnthropicStream(gated, body.model, onStreamUsage, onMidStreamError);
      attempts.push({ entry, status: 200 });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    const json = await upstream.json();
    const translated =
      p.kind === 'gemini'
        ? geminiToAnthropic(json as GeminiResponse, body.model)
        : openAIToAnthropic(json as OpenAIResponse, body.model);
    attempts.push({ entry, status: 200, usage: translated.usage });
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
  const chain = ctx.forced ? [ctx.forced] : (cfg.lanes[lane] ?? cfg.lanes[cfg.default_lane] ?? []);
  const attempts: RouteAttempt[] = [];

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
      const plan = await ctx.stub.filterChain(chain, limitsByEntry, ctx.sessionId);
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
    // Streamed responses learn token usage only at stream end (after this handler
    // returned) — attach it to the route record then; waitUntil keeps us alive.
    const onStreamUsage = ctx.stub
      ? (usage: { input_tokens: number; output_tokens: number }) => {
          ctx.waitUntil(
            ctx
              .stub!.attachUsage(entry, usage)
              .catch((e) => console.log(`usage attach failed: ${String(e)}`)),
          );
        }
      : undefined;
    // A stream dying AFTER content started can't be re-routed (Anthropic bytes are
    // already flushed) — but cool the model down and break stickiness so the very
    // next turn routes elsewhere instead of looping on a broken provider.
    const onMidStreamError = ctx.stub
      ? () => {
          ctx.waitUntil(
            ctx
              .stub!.reportOutcome(entry, false, {
                kind: 'stream-error',
                sessionId: ctx.sessionId,
                lane,
                detail: 'died mid-stream after content started',
              })
              .catch((e) => console.log(`mid-stream report failed: ${String(e)}`)),
          );
        }
      : undefined;
    const res = await tryChainEntry(
      env,
      cfg,
      entry,
      body,
      attempts,
      ctx.privacySensitive,
      onStreamUsage,
      onMidStreamError,
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
