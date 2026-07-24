// M6 fit filter (BUILD_PLAN_V2 §4, SPEC_V2 §5): never dispatch a request to a
// chain entry that structurally cannot hold it. A 400-byte "hello" and a
// 200,000-char repo dump both flow through every provider today; every
// oversize dispatch that gets rejected upstream still burns that provider's
// daily quota (SPEC_V2 §2 — the highest-leverage v2 story).
//
// No tokeniser (CPU budget — SPEC_V2 §4 non-goals): est_in = bytes / ratio,
// ratio seeded at 3.6 and self-calibrated per provider from each response's
// actual usage.input_tokens via an EWMA. State is isolate-local (mirrors
// privacy.ts's compiled-guard cache) — cheap, O(1), reseeds cold; a Worker
// isolate serves many requests, so it converges within a session.
import type { RouterConfig } from './config';
import { parseChainEntry } from './config';

const SEED_RATIO = 3.6; // bytes per token — code-dense text (SPEC_V2 §5)
const EWMA_ALPHA = 0.2;
const HEADROOM = 1.1; // 10% headroom on the "need" estimate (SPEC_V2 §5)

const ratioByProvider = new Map<string, number>();

export function currentRatio(provider: string): number {
  return ratioByProvider.get(provider) ?? SEED_RATIO;
}

/** Correct a provider's byte/token ratio from one response's real usage. Never
 *  invoked on the hot path itself — callers fire this off the response path
 *  (buffered: synchronously after the JSON is already parsed; live streams:
 *  inside the same `ctx.waitUntil` that already records usage — router.ts). */
export function recordActualTokens(provider: string, bytes: number, actualTokens: number): void {
  if (bytes <= 0 || actualTokens <= 0) return;
  const observed = bytes / actualTokens;
  const prev = currentRatio(provider);
  ratioByProvider.set(provider, prev + EWMA_ALPHA * (observed - prev));
}

export function estimateInputTokens(provider: string, bytes: number): number {
  return Math.ceil(bytes / currentRatio(provider));
}

/** Test-only: reset calibration state between unit tests. */
export function resetRatios(): void {
  ratioByProvider.clear();
}

interface EntryLimits {
  ctx?: number;
  maxOut?: number;
  tpm?: number;
}

function limitsOf(cfg: RouterConfig, provider: string, model: string): EntryLimits {
  const p = cfg.providers[provider];
  const ml = p?.model_limits?.[model];
  return {
    ctx: ml?.ctx ?? p?.default_ctx,
    maxOut: ml?.max_out,
    tpm: ml?.tpm ?? p?.limits.tpm,
  };
}

export interface FitCheck {
  fits: boolean;
  estIn: number;
  need: number;
  ctx?: number;
  tpm?: number;
  /** Which bound tripped, when fits=false. */
  reason?: 'ctx' | 'tpm';
}

/**
 * Check one chain entry against an estimated request size.
 * need = est_in + effective_max_out, headroomed 10%; effective_max_out is the
 * request's own max_tokens, capped by the model's declared max_out if smaller.
 * Unknown ctx never hard-drops (SPEC_V2 §5) — fits=true, ctx=undefined; the
 * caller (filterChainByFit) is what ranks unknown-ctx entries last.
 */
export function checkFit(
  cfg: RouterConfig,
  entry: string,
  estBytes: number,
  requestedMaxTokens: number,
): FitCheck {
  const { provider, model } = parseChainEntry(entry);
  const { ctx, maxOut, tpm } = limitsOf(cfg, provider, model);
  const estIn = estimateInputTokens(provider, estBytes);
  const effectiveMaxOut =
    maxOut !== undefined ? Math.min(requestedMaxTokens, maxOut) : requestedMaxTokens;
  const need = Math.ceil((estIn + effectiveMaxOut) * HEADROOM);

  if (tpm !== undefined && estIn > tpm)
    return { fits: false, estIn, need, ctx, tpm, reason: 'tpm' };
  if (ctx !== undefined && need > ctx) return { fits: false, estIn, need, ctx, tpm, reason: 'ctx' };
  return { fits: true, estIn, need, ctx, tpm };
}

export interface FitSkip {
  entry: string;
  detail: string;
  ctx?: number;
}

export interface FitFilterResult {
  /** Fitting entries first (original relative order), then unknown-ctx entries
   *  (also original relative order) — never reordered against each other. */
  order: string[];
  skipped: FitSkip[];
}

/**
 * Filter + reorder a lane chain by fit. A config with no ctx/tpm/default_ctx
 * anywhere makes every entry "unknown" — output order equals input order
 * exactly, so an unmodified v1 config routes byte-identically (BUILD_PLAN_V2
 * §6.11, CI-enforced regression).
 */
export function filterChainByFit(
  cfg: RouterConfig,
  chain: string[],
  estBytes: number,
  requestedMaxTokens: number,
): FitFilterResult {
  const known: string[] = [];
  const unknown: string[] = [];
  const skipped: FitSkip[] = [];

  for (const entry of chain) {
    const check = checkFit(cfg, entry, estBytes, requestedMaxTokens);
    if (!check.fits) {
      skipped.push({
        entry,
        detail: `est_in=${check.estIn} need=${check.need} ctx=${check.ctx ?? '?'} tpm=${check.tpm ?? '?'} (${check.reason})`,
        ctx: check.ctx,
      });
      continue;
    }
    (check.ctx === undefined ? unknown : known).push(entry);
  }
  return { order: [...known, ...unknown], skipped };
}

/** Declared ctx for one chain entry, or undefined when unknown. */
export function ctxOf(cfg: RouterConfig, entry: string): number | undefined {
  const { provider, model } = parseChainEntry(entry);
  return limitsOf(cfg, provider, model).ctx;
}

/** Largest declared ctx among a chain's entries — for the "fits nothing" notice. */
export function largestCtx(cfg: RouterConfig, chain: string[]): number | undefined {
  let max: number | undefined;
  for (const entry of chain) {
    const ctx = ctxOf(cfg, entry);
    if (ctx !== undefined && (max === undefined || ctx > max)) max = ctx;
  }
  return max;
}

/** Smallest declared ctx among a chain's entries — derives the dispatcher's
 *  LONGCTX heuristic threshold (BUILD_PLAN_V2 §4 M6) from real config instead
 *  of a hardcoded constant. Entries with unknown ctx don't count. */
export function smallestCtx(cfg: RouterConfig, chain: string[]): number | undefined {
  let min: number | undefined;
  for (const entry of chain) {
    const ctx = ctxOf(cfg, entry);
    if (ctx !== undefined && (min === undefined || ctx < min)) min = ctx;
  }
  return min;
}
