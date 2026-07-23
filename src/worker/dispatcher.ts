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

/** chars/4 across the whole request — same estimate count_tokens uses. */
export function estimateTokens(body: AnthropicRequest): number {
  let chars = typeof body.system === 'string' ? body.system.length : 0;
  if (Array.isArray(body.system)) for (const b of body.system) chars += b.text.length;
  chars += JSON.stringify(body.messages).length;
  return Math.ceil(chars / 4);
}

/** 0ms pre-filter (BUILD_PLAN M3): tiny & tool-less → FAST; huge context → LONGCTX. */
export function heuristicLane(body: AnthropicRequest): Lane | null {
  const tokens = estimateTokens(body);
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
export function taskDigest(body: AnthropicRequest): string {
  const toolNames = (body.tools ?? []).map((t) => t.name).slice(0, 25);
  return JSON.stringify({
    task: lastUserText(body).slice(0, 1500),
    tools: toolNames,
    tool_count: body.tools?.length ?? 0,
    turns: body.messages.length,
    approx_tokens: estimateTokens(body),
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
  entry: string; // "google/gemini-3.5-flash-lite"
  timeout_ms: number;
  cache_ttl_s: number;
  confidence_floor: number;
}

export function classifierConfig(cfg: RouterConfig): ClassifierConfig | null {
  const d = cfg.dispatcher;
  if (!d?.model) return null;
  return {
    entry: d.model,
    timeout_ms: d.timeout_ms ?? 1500,
    cache_ttl_s: d.cache_ttl_s ?? 300,
    confidence_floor: d.confidence_floor ?? 0.6,
  };
}

async function callClassifier(
  env: Env,
  cfg: RouterConfig,
  cc: ClassifierConfig,
  digest: string,
): Promise<{ lane: Lane; confidence: number } | null> {
  const { provider, model } = parseChainEntry(cc.entry);
  const p = cfg.providers[provider];
  if (!p || p.kind !== 'gemini') return null;
  const key = (env as unknown as Record<string, string | undefined>)[p.key_env];
  if (!key) return null;

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
    signal: AbortSignal.timeout(cc.timeout_ms),
  });
  if (!res.ok) {
    console.log(`classifier HTTP ${res.status}`);
    return null;
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
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

/**
 * Full dispatch: heuristics → DO verdict cache → classifier (metered against the
 * classifier provider's ledger) → AGENTIC fallback.
 */
export async function dispatch(
  env: Env,
  cfg: RouterConfig,
  body: AnthropicRequest,
  stub: DurableObjectStub<KompassState> | null,
): Promise<DispatchResult> {
  const t0 = Date.now();

  const h = heuristicLane(body);
  if (h && cfg.lanes[h]) return { lane: h, source: 'heuristic', ms: Date.now() - t0 };

  const cc = classifierConfig(cfg);
  if (!cc) return { lane: FALLBACK_LANE, source: 'fallback', ms: Date.now() - t0 };

  const digest = taskDigest(body);
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

  try {
    // Meter the classifier call against its provider budget (it is a real request).
    if (stub) {
      const { provider, model } = parseChainEntry(cc.entry);
      const p = cfg.providers[provider];
      const limits = p?.model_limits?.[model] ?? p?.limits;
      if (p && limits) {
        const key = p.model_limits?.[model] ? `${provider}:${model}` : provider;
        const r = await stub.reserve(key, limits);
        if (!r.ok) return { lane: FALLBACK_LANE, source: 'fallback', ms: Date.now() - t0 };
      }
    }
    const verdict = await callClassifier(env, cfg, cc, digest);
    if (verdict) {
      const lane =
        verdict.confidence < cc.confidence_floor || !cfg.lanes[verdict.lane]
          ? FALLBACK_LANE
          : verdict.lane;
      if (stub) {
        stub
          .putVerdict(key, { lane, confidence: verdict.confidence }, cc.cache_ttl_s)
          .catch((e) => console.log(`verdict cache write failed: ${String(e)}`));
      }
      return { lane, source: 'classifier', ms: Date.now() - t0, confidence: verdict.confidence };
    }
  } catch (e) {
    console.log(`classifier unavailable (${String(e).slice(0, 120)}) — heuristics-only`);
  }
  return { lane: FALLBACK_LANE, source: 'fallback', ms: Date.now() - t0 };
}
