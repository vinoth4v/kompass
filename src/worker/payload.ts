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

/** Gemini-dialect payload. Both call sites send non-streaming bodies, so the
 *  cached translation is returned as-is — nothing per-attempt varies. */
export function geminiPayload(body: AnthropicRequest): GeminiRequest {
  const slot = slotFor(body);
  slot.gemini ??= anthropicToGemini({ ...body, stream: false });
  return slot.gemini;
}
