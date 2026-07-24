// Non-chat capabilities served from the same free-provider pool: image
// generation (POST /v1/images/generations) and embeddings (POST /v1/embeddings).
// Each walks its own ordered fallback chain from config (images.chain /
// embeddings.chain), metered against the same Durable Object ledger as chat
// traffic, with failures falling through invisibly — same reliability model,
// different payload shapes.
//
// Live-verified upstream shapes (2026-07-24, see DECISIONS.md):
// - Workers AI text-to-image: POST {account}/ai/run/@cf/... — flux returns JSON
//   {result:{image:<b64 jpeg>}}, SDXL-family returns raw image/png bytes.
// - Workers AI embeddings: POST run/@cf/baai/bge-m3 {text:[...]} →
//   {result:{data:[[...]]}}.
// - Gemini embeddings: POST models/{m}:batchEmbedContents → {embeddings:[{values}]}.
// - Gemini image models (gemini-*-image): generateContent returning inlineData
//   parts — implemented for when a key has quota; excluded from the default
//   chain (429 "check your plan" on the free tier at ship time).
import type { KompassState, FailureKind } from '../do/state';
import type { ProviderConfig, RouterConfig } from './config';
import { isModelDisabled, limitsFor, parseChainEntry } from './config';
import { counterKey } from './router';
import type { Env } from './env';

const TIMEOUT_MS = 90_000;

export interface CapabilityAttempt {
  entry: string;
  status: number | string;
  detail?: string;
}

interface CapabilityOutcome<T> {
  result: T | null;
  attempts: CapabilityAttempt[];
  used?: string;
}

function providerKey(env: Env, p: ProviderConfig): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[p.key_env];
}

/** Workers AI native run endpoint, derived from the provider's OpenAI-compat base_url:
 *  …/accounts/{id}/ai/v1 → …/accounts/{id}/ai/run/@cf/<model> */
function workersAiRunUrl(p: ProviderConfig, model: string): string {
  return `${p.base_url.replace(/\/v1$/, '')}/run/${model}`;
}

function failureKind(status: number | string): FailureKind {
  if (status === 429) return '429';
  if (status === 'timeout') return 'timeout';
  if (typeof status === 'number') return '5xx';
  return 'stream-error';
}

type EntryFn<T> = (
  p: ProviderConfig,
  key: string,
  model: string,
  signal: AbortSignal,
) => Promise<T | { error: { status: number | string; detail: string } }>;

/** Shared chain walk: ledger reserve → attempt → outcome report → fall through. */
async function walkChain<T>(
  env: Env,
  cfg: RouterConfig,
  chain: string[],
  lane: string,
  stub: DurableObjectStub<KompassState> | null,
  attempt: EntryFn<T>,
): Promise<CapabilityOutcome<T>> {
  const attempts: CapabilityAttempt[] = [];
  for (const entry of chain) {
    const { provider, model } = parseChainEntry(entry);
    const p = cfg.providers[provider];
    if (!p) {
      attempts.push({ entry, status: 'error', detail: 'unknown provider' });
      continue;
    }
    if (p.enabled === false) {
      attempts.push({ entry, status: 'skipped-disabled' });
      continue;
    }
    if (isModelDisabled(cfg, entry)) {
      attempts.push({ entry, status: 'skipped-disabled-model' });
      continue;
    }
    const key = providerKey(env, p);
    if (!key) {
      attempts.push({ entry, status: 'skipped-no-key' });
      continue;
    }
    if (stub) {
      try {
        const r = await stub.reserve(counterKey(provider, model, p), limitsFor(p, model));
        if (!r.ok) {
          attempts.push({ entry, status: `skipped-${r.reason} exhausted` });
          continue;
        }
      } catch (e) {
        console.log(`DO reserve failed, proceeding unmetered: ${String(e)}`);
      }
    }
    const t0 = Date.now();
    let result: T | null = null;
    try {
      const r = await attempt(p, key, model, AbortSignal.timeout(TIMEOUT_MS));
      if (r && typeof r === 'object' && 'error' in (r as object)) {
        const err = (r as { error: { status: number | string; detail: string } }).error;
        attempts.push({ entry, status: err.status, detail: err.detail.slice(0, 200) });
      } else {
        result = r as T;
        attempts.push({ entry, status: 200 });
      }
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
      attempts.push({
        entry,
        status: timedOut ? 'timeout' : 'error',
        detail: String(e).slice(0, 200),
      });
    }
    if (stub) {
      const last = attempts[attempts.length - 1];
      await stub
        .reportOutcome(entry, result !== null, {
          kind: result === null && last ? failureKind(last.status) : undefined,
          lane,
          ms: Date.now() - t0,
          detail: result === null ? last?.detail?.slice(0, 120) : undefined,
        })
        .catch((e) => console.log(`DO report failed: ${String(e)}`));
    }
    if (result !== null) return { result, attempts, used: entry };
  }
  return { result: null, attempts };
}

// ---------------------------------------------------------------- images ----

export interface GeneratedImage {
  b64: string;
  mime: string;
}

interface GeminiImageResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  error?: { message?: string };
}

async function generateImageOnEntry(
  p: ProviderConfig,
  key: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<GeneratedImage | { error: { status: number | string; detail: string } }> {
  if (p.kind === 'gemini') {
    const res = await fetch(`${p.base_url}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal,
    });
    if (!res.ok) return { error: { status: res.status, detail: (await res.text()).slice(0, 300) } };
    const j = (await res.json()) as GeminiImageResponse;
    for (const part of j.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return { b64: part.inlineData.data, mime: part.inlineData.mimeType ?? 'image/png' };
      }
    }
    return { error: { status: 'error', detail: 'no inlineData image in response' } };
  }
  if (!model.startsWith('@cf/')) {
    return { error: { status: 'error', detail: 'image generation unsupported on this provider' } };
  }
  const res = await fetch(workersAiRunUrl(p, model), {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok) return { error: { status: res.status, detail: (await res.text()).slice(0, 300) } };
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    // flux family: {result: {image: <base64 JPEG>}, success: true}
    const j = (await res.json()) as {
      result?: { image?: string };
      success?: boolean;
      errors?: unknown[];
    };
    if (j.result?.image) return { b64: j.result.image, mime: 'image/jpeg' };
    return { error: { status: 'error', detail: JSON.stringify(j.errors ?? j).slice(0, 300) } };
  }
  if (contentType.startsWith('image/')) {
    // SDXL family: raw image bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { b64: btoa(bin), mime: contentType.split(';')[0] ?? 'image/png' };
  }
  return { error: { status: 'error', detail: `unexpected content-type ${contentType}` } };
}

export async function routeImageGeneration(
  env: Env,
  cfg: RouterConfig,
  prompt: string,
  stub: DurableObjectStub<KompassState> | null,
): Promise<CapabilityOutcome<GeneratedImage>> {
  return walkChain(env, cfg, cfg.images?.chain ?? [], 'IMAGES', stub, (p, key, model, signal) =>
    generateImageOnEntry(p, key, model, prompt, signal),
  );
}

// ------------------------------------------------------------ embeddings ----

interface GeminiBatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
}

async function embedOnEntry(
  p: ProviderConfig,
  key: string,
  model: string,
  inputs: string[],
  signal: AbortSignal,
): Promise<number[][] | { error: { status: number | string; detail: string } }> {
  if (p.kind === 'gemini') {
    const res = await fetch(`${p.base_url}/models/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: inputs.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      }),
      signal,
    });
    if (!res.ok) return { error: { status: res.status, detail: (await res.text()).slice(0, 300) } };
    const j = (await res.json()) as GeminiBatchEmbedResponse;
    const vectors = (j.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== inputs.length || vectors.some((v) => v.length === 0)) {
      return { error: { status: 'error', detail: 'missing embeddings in response' } };
    }
    return vectors;
  }
  if (model.startsWith('@cf/')) {
    // Workers AI native embeddings: {text: [...]} → {result: {data: [[...]]}}
    const res = await fetch(workersAiRunUrl(p, model), {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: inputs }),
      signal,
    });
    if (!res.ok) return { error: { status: res.status, detail: (await res.text()).slice(0, 300) } };
    const j = (await res.json()) as { result?: { data?: number[][] }; errors?: unknown[] };
    const vectors = j.result?.data;
    if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
      return { error: { status: 'error', detail: JSON.stringify(j.errors ?? j).slice(0, 300) } };
    }
    return vectors;
  }
  // Generic OpenAI-compatible /v1/embeddings (future providers).
  const res = await fetch(`${p.base_url}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: inputs, encoding_format: 'float' }),
    signal,
  });
  if (!res.ok) return { error: { status: res.status, detail: (await res.text()).slice(0, 300) } };
  const j = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const data = j.data ?? [];
  if (data.length !== inputs.length) {
    return { error: { status: 'error', detail: 'missing embeddings in response' } };
  }
  // OpenAI results carry an index — respect it rather than assuming order.
  const vectors: number[][] = new Array(inputs.length);
  data.forEach((d, i) => {
    vectors[d.index ?? i] = d.embedding ?? [];
  });
  if (vectors.some((v) => !v || v.length === 0)) {
    return { error: { status: 'error', detail: 'empty embedding vector in response' } };
  }
  return vectors;
}

export async function routeEmbeddings(
  env: Env,
  cfg: RouterConfig,
  inputs: string[],
  stub: DurableObjectStub<KompassState> | null,
): Promise<CapabilityOutcome<number[][]>> {
  return walkChain(
    env,
    cfg,
    cfg.embeddings?.chain ?? [],
    'EMBEDDINGS',
    stub,
    (p, key, model, signal) => embedOnEntry(p, key, model, inputs, signal),
  );
}
