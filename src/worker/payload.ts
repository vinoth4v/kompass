// Per-request upstream-payload cache (Cloudflare error 1102).
//
// callUpstream/callLive used to run the FULL Anthropic→provider translation on
// every chain attempt. Claude Code contexts reach megabytes, and each attempt
// therefore built a fresh multi-MB messages array plus a fresh serialized copy.
// One request that walked a long chain did that work dozens of times over —
// measured 538ms CPU and ~20MB peak memory per invocation during real sessions
// (vs ~3ms / 2.3MB when chains resolve on the first entry). Memory is per
// ISOLATE, shared by every concurrent request, so a handful of parallel Claude
// Code requests at 20MB each is what tips an isolate over and gets the whole
// batch killed with "exceeded resource limits".
//
// The deep part of a translation (messages, tools) depends only on the request.
// `model`, `stream` and `stream_options` are shallow top-level fields. So the
// deep translation is done ONCE per request and shared; each attempt only makes
// a shallow copy and re-serializes. Keyed by the request object's identity in a
// WeakMap, so entries are collected with the request and nothing leaks between
// requests (a module-level Map here would be a cross-request memory leak — the
// isolate outlives the request).
import { anthropicToOpenAI } from '../adapters/openai';
import { anthropicToGemini, type GeminiRequest } from '../adapters/gemini';
import type { AnthropicRequest, OpenAIRequest } from '../adapters/types';

interface Slot {
  openai?: OpenAIRequest;
  gemini?: GeminiRequest;
  /** Serialized canonical body minus the leading '{' and the per-attempt
   *  model/stream fields; '' means "no other fields". */
  openaiTail?: string;
  geminiJson?: string;
}

const cache = new WeakMap<AnthropicRequest, Slot>();

function slotFor(body: AnthropicRequest): Slot {
  let slot = cache.get(body);
  if (!slot) {
    slot = {};
    cache.set(body, slot);
  }
  return slot;
}

/**
 * OpenAI-dialect payload for one attempt. The cached canonical form is built
 * with stream:false (so it never carries stream_options); `model` and `stream`
 * are applied per attempt on a shallow copy — the big `messages`/`tools` arrays
 * are shared by reference, never rebuilt.
 *
 * Prefer openAIBody() on the request path: this returns the OBJECT, so the
 * caller still pays a full JSON.stringify per attempt.
 */
export function openAIPayload(
  body: AnthropicRequest,
  model: string,
  stream: boolean,
): OpenAIRequest {
  const slot = slotFor(body);
  slot.openai ??= anthropicToOpenAI({ ...body, stream: false }, model);
  // Callers that stream delete stream_options themselves (some free providers
  // reject it); the canonical copy never has it, so there is nothing to strip.
  return { ...slot.openai, model, stream };
}

/**
 * Serialized OpenAI request body, with the per-attempt fields spliced in.
 *
 * Caching the translated OBJECT was only half the fix: JSON.stringify still ran
 * on every attempt, walking a multi-MB message graph and allocating a fresh
 * multi-MB string each time. With 8 attempts on a 180k-token context that is
 * most of the isolate's memory, and it is why 1102s continued after the first
 * fix (76 more, peaking at 29.9MB).
 *
 * `model` and `stream` are the ONLY top-level fields that vary per attempt, so
 * everything else is serialized once and reused as a string tail. The result is
 * one object walk per request instead of one per attempt.
 */
export function openAIBody(body: AnthropicRequest, model: string, stream: boolean): string {
  const slot = slotFor(body);
  if (slot.openaiTail === undefined) {
    const canonical = { ...openAIPayload(body, model, false) } as Partial<OpenAIRequest>;
    delete canonical.model;
    delete canonical.stream;
    const json = JSON.stringify(canonical);
    // '{"a":1}' -> '"a":1}'. An empty object would yield a bare '}' and a
    // trailing comma below, so mark that case with the empty string.
    slot.openaiTail = json === '{}' ? '' : json.slice(1);
  }
  const head = `{"model":${JSON.stringify(model)},"stream":${stream ? 'true' : 'false'}`;
  return slot.openaiTail === '' ? `${head}}` : `${head},${slot.openaiTail}`;
}

/** Gemini-dialect payload. Both call sites send non-streaming bodies, so the
 *  cached translation is returned as-is — nothing per-attempt varies. */
export function geminiPayload(body: AnthropicRequest): GeminiRequest {
  const slot = slotFor(body);
  slot.gemini ??= anthropicToGemini({ ...body, stream: false });
  return slot.gemini;
}

/** Serialized Gemini body. Nothing varies per attempt, so this is serialized
 *  exactly once per request no matter how far down the chain it walks. */
export function geminiBody(body: AnthropicRequest): string {
  const slot = slotFor(body);
  slot.geminiJson ??= JSON.stringify(geminiPayload(body));
  return slot.geminiJson;
}
