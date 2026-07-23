// M3 Dispatcher: heuristic pre-filter (0ms) → cached classifier verdict →
// fast-reasoning-model classifier (strict JSON) → safe fallback. Never blocks:
// any classifier failure degrades to heuristics-only routing (SPEC §4).
import type { AnthropicRequest } from '../adapters/types';
import type { KompassState } from '../do/state';
import type { RouterConfig } from './config';
import { parseChainEntry } from './config';
import type { Env } from './env';

export const LANES = ['FAST', 'SIMPLE', 'AGENTIC', 'HARD', 'LONGCTX'] as const;
export type Lane = (typeof LANES)[number];

export interface DispatchResult {
  lane: string;
  source: 'forced' | 'heuristic' | 'cache' | 'classifier' | 'fallback';
  ms: number;
  confidence?: number;
}

const FALLBACK_LANE: Lane = 'AGENTIC'; // safe middle (SPEC §4)

/**
 * chars/4 estimate. Prefer passing rawLength (the already-read request text length)
 * — re-stringifying a megabyte conversation costs real CPU against the free plan's
 * ~10ms budget (error 1102). The stringify path remains as a fallback for callers
 * without the raw text (unit tests).
 */
export function estimateTokens(body: AnthropicRequest, rawLength?: number): number {
  if (rawLength !== undefined) return Math.ceil(rawLength / 4);
  let chars = typeof body.system === 'string' ? body.system.length : 0;
  if (Array.isArray(body.system)) for (const b of body.system) chars += b.text.length;
  chars += JSON.stringify(body.messages).length;
  return Math.ceil(chars / 4);
}

/** 0ms pre-filter (BUILD_PLAN M3): tiny & tool-less → FAST; huge context → LONGCTX. */
export function heuristicLane(body: AnthropicRequest, rawLength?: number): Lane | null {
  const tokens = estimateTokens(body, rawLength);
  if (tokens > 60_000) return 'LONGCTX';
  if (tokens < 1_000 && !body.tools?.length) return 'FAST';
  return null;
}

function lastUserText(body: AnthropicRequest): string {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const texts = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text);
    if (texts.length) return texts.join('\n');
  }
  return '';
}

/** Compressed task digest (≤~500 tokens) — also the verdict-cache key material. */
export function taskDigest(body: AnthropicRequest, rawLength?: number): string {
  const toolNames = (body.tools ?? []).map((t) => t.name).slice(0, 25);
  return JSON.stringify({
    task: lastUserText(body).slice(0, 1500),
    tools: toolNames,
    tool_count: body.tools?.length ?? 0,
    turns: body.messages.length,
    approx_tokens: estimateTokens(body, rawLength),
  });
}

async function digestKey(digest: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digest));
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const CLASSIFIER_PROMPT = `You are a routing classifier for coding-agent requests. Classify the task into exactly one lane:
- FAST: trivial/quick lookups, one-liners, renames, formatting, short questions
- SIMPLE: straightforward single-file code edits, docstrings, small well-specified functions
- AGENTIC: multi-step coding with tools (editing files, running commands, tests), typical feature work
- HARD: deep debugging, architecture, tricky algorithms, large refactors needing max reasoning
- LONGCTX: the context is huge (whole-repo dumps, very long documents)

Reply with ONLY strict JSON: {"lane":"<FAST|SIMPLE|AGENTIC|HARD|LONGCTX>","confidence":<0..1>}`;

interface ClassifierConfig {
  /** primary + fallback classifier entries, tried in order */
  entries: string[];
  timeout_ms: number;
  cache_ttl_s: number;
  confidence_floor: number;
}

export function classifierConfig(cfg: RouterConfig): ClassifierConfig | null {
  const d = cfg.dispatcher;
  if (!d?.model) return null;
  return {
    entries: [d.model, ...(d.fallbacks ?? [])],
    timeout_ms: d.timeout_ms ?? 1500,
    cache_ttl_s: d.cache_ttl_s ?? 300,
    confidence_floor: d.confidence_floor ?? 0.6,
  };
}

function parseVerdict(text: string): { lane: Lane; confidence: number } | null {
  try {
    const verdict = JSON.parse(text) as { lane?: string; confidence?: number };
    if (verdict.lane && (LANES as readonly string[]).includes(verdict.lane)) {
      return { lane: verdict.lane as Lane, confidence: verdict.confidence ?? 0 };
    }
  } catch {
    console.log(`classifier returned non-JSON: ${text.slice(0, 120)}`);
  }
  return null;
}

/** One classifier attempt against a single entry — supports gemini AND openai kinds. */
async function callClassifier(
  env: Env,
  cfg: RouterConfig,
  entry: string,
  timeoutMs: number,
  digest: string,
): Promise<{ lane: Lane; confidence: number } | null> {
  const { provider, model } = parseChainEntry(entry);
  const p = cfg.providers[provider];
  if (!p || p.enabled === false) return null;
  const key = (env as unknown as Record<string, string | undefined>)[p.key_env];
  if (!key) return null;

  if (p.kind === 'gemini') {
    const res = await fetch(`${p.base_url}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CLASSIFIER_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: digest }] }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.log(`classifier ${entry} HTTP ${res.status}`);
      return null;
    }
    const parsed = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    } | null;
    const json = parsed ?? {};
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => part && !part.thought)
      .map((part) => part.text ?? '')
      .join('');
    return parseVerdict(text);
  }

  // openai-format backup classifiers (groq/mistral/… — JSON mode verified per model)
  const res = await fetch(`${p.base_url}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: digest },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    console.log(`classifier ${entry} HTTP ${res.status}`);
    return null;
  }
  const parsed = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;
  return parseVerdict(parsed?.choices?.[0]?.message?.content ?? '');
}

/**
 * Full dispatch: heuristics → DO verdict cache → classifier (metered against the
 * classifier provider's ledger) → AGENTIC fallback.
 */
export async function dispatch(
  env: Env,
  cfg: RouterConfig,
  body: AnthropicRequest,
  stub: DurableObjectStub<KompassState> | null,
  rawLength?: number,
): Promise<DispatchResult> {
  const t0 = Date.now();

  const h = heuristicLane(body, rawLength);
  if (h && cfg.lanes[h]) return { lane: h, source: 'heuristic', ms: Date.now() - t0 };

  const cc = classifierConfig(cfg);
  if (!cc) return { lane: FALLBACK_LANE, source: 'fallback', ms: Date.now() - t0 };

  const digest = taskDigest(body, rawLength);
  const key = await digestKey(digest);

  if (stub) {
    try {
      const cached = await stub.getVerdict(key);
      if (cached && cfg.lanes[cached.lane]) {
        return {
          lane: cached.lane,
          source: 'cache',
          ms: Date.now() - t0,
          confidence: cached.confidence,
        };
      }
    } catch (e) {
      console.log(`verdict cache read failed: ${String(e)}`);
    }
  }

  // Primary + backups, tried in order: each attempt is metered against its own
  // provider budget; exhausted/failed entries fall through to the next.
  for (const entry of cc.entries) {
    try {
      if (stub) {
        const { provider, model } = parseChainEntry(entry);
        const p = cfg.providers[provider];
        const limits = p?.model_limits?.[model] ?? p?.limits;
        if (p && limits) {
          const counter = p.model_limits?.[model] ? `${provider}:${model}` : provider;
          const r = await stub.reserve(counter, limits);
          if (!r.ok) continue;
        }
      }
      const verdict = await callClassifier(env, cfg, entry, cc.timeout_ms, digest);
      if (verdict) {
        const lane =
          verdict.confidence < cc.confidence_floor || !cfg.lanes[verdict.lane]
            ? FALLBACK_LANE
            : verdict.lane;
        if (stub) {
          // Awaited: a dangling promise is cancelled when the Worker invocation ends,
          // which silently disabled the cache (observed live: 8/8 classifier calls).
          await stub
            .putVerdict(key, { lane, confidence: verdict.confidence }, cc.cache_ttl_s)
            .catch((e) => console.log(`verdict cache write failed: ${String(e)}`));
        }
        return { lane, source: 'classifier', ms: Date.now() - t0, confidence: verdict.confidence };
      }
    } catch (e) {
      console.log(`classifier ${entry} unavailable (${String(e).slice(0, 100)}) — trying next`);
    }
  }
  return { lane: FALLBACK_LANE, source: 'fallback', ms: Date.now() - t0 };
}
