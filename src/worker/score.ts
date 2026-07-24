// M8 quality signal & adaptive weights (BUILD_PLAN_V2 §4, SPEC_V2 §5): pure
// scoring math + a corrective-turn heuristic, storage-agnostic so it's
// testable without a Durable Object — KompassState (state.ts) owns the actual
// ctx.storage reads/writes around these functions, same split as M7's
// fit.ts/trace.ts.
//
// health(m)  = EWMA over {completed stream = 1, 5xx/429/timeout/truncated = 0}
// quality(m) = clamp(1 − penalties/attempts, floor 0.1)
// score(m)   = health × quality        spread weight = score²
//
// Scored per (model, lane) — a model can be excellent in SIMPLE and poor in
// AGENTIC. `attempts` is the SAME counter behind both health's EWMA and
// quality's denominator: every real dispatch increments it once
// (`applyAttempt`); escalation-attribution and corrective-turn penalties are
// retroactive adjustments to an attempt already counted, so they only touch
// `penalties` (`applyPenalty`) — they don't count as new attempts and never
// move health, matching SPEC_V2 §5's health formula, which lists only
// protocol-level outcomes.
import type { AnthropicRequest } from '../adapters/types';
import type { RouterConfig } from './config';

export const HEALTH_ALPHA = 0.2;
export const QUALITY_FLOOR = 0.1;
// Sparse-data guard (BUILD_PLAN_V2 §4): below this many real attempts, quality
// isn't trusted — score is health-only, and demotion never fires at all.
export const MIN_ATTEMPTS_FOR_SCORING = 10;
// Below this score, for this many CONSECUTIVE evaluations (once the sparse
// guard has lifted), an entry demotes out of the spread pool.
export const DEMOTE_SCORE_FLOOR = 0.5;
export const DEMOTE_CONSECUTIVE_K = 3;

export const PENALTY = {
  escalation: 1.0,
  malformed_tool_call: 0.7,
  empty_or_truncated: 0.7,
  corrective_turn: 0.4,
} as const;

export interface ScoreCell {
  health: number;
  penalties: number;
  attempts: number;
  /** Consecutive evaluations with score < DEMOTE_SCORE_FLOOR, tracked from the
   *  first attempt (not gated by the sparse guard) — only the `demoted` flag
   *  itself is gated, so a streak that built up during the health-only window
   *  can demote immediately once MIN_ATTEMPTS_FOR_SCORING is crossed, rather
   *  than needing K MORE bad attempts after the gate lifts. */
  belowFloorStreak: number;
  demoted: boolean;
}

export function newScoreCell(): ScoreCell {
  // Optimistic seed (health=1) — same "give untested entries a fair first
  // try" philosophy as the pre-M8 perf-ratio weighting.
  return { health: 1, penalties: 0, attempts: 0, belowFloorStreak: 0, demoted: false };
}

export function updateHealth(prev: number, healthy: boolean, alpha = HEALTH_ALPHA): number {
  return prev + alpha * ((healthy ? 1 : 0) - prev);
}

export function computeQuality(penalties: number, attempts: number, floor = QUALITY_FLOOR): number {
  if (attempts <= 0) return 1;
  return Math.max(floor, Math.min(1, 1 - penalties / attempts));
}

/** Quality defaults to 1 (health-only) below the sparse-data threshold. */
export function effectiveQuality(penalties: number, attempts: number): number {
  return attempts < MIN_ATTEMPTS_FOR_SCORING ? 1 : computeQuality(penalties, attempts);
}

export function computeScore(health: number, quality: number): number {
  return health * quality;
}

/** `pin` floors the score — "pin: beats a terrible one" (human judgment always wins). */
export function effectiveScore(health: number, quality: number, pin: number | undefined): number {
  const raw = computeScore(health, quality);
  return pin !== undefined ? Math.max(raw, pin) : raw;
}

export function spreadWeight(score: number): number {
  return score ** 2;
}

function reevaluateDemotion(cell: ScoreCell, pin: number | undefined): ScoreCell {
  const quality = effectiveQuality(cell.penalties, cell.attempts);
  const score = effectiveScore(cell.health, quality, pin);
  let belowFloorStreak = cell.belowFloorStreak;
  let demoted = cell.demoted;
  if (score < DEMOTE_SCORE_FLOOR) {
    belowFloorStreak++;
    if (cell.attempts >= MIN_ATTEMPTS_FOR_SCORING && belowFloorStreak >= DEMOTE_CONSECUTIVE_K) {
      demoted = true;
    }
  } else {
    // Score is healthy again — whether from real improvement or a pin, human
    // judgment always wins (guardrail §6.15): don't leave an entry stuck
    // showing "demoted" once its (possibly pin-floored) score no longer
    // supports that. This is IN ADDITION TO applyAttempt's single-healthy-
    // attempt auto-recovery below, not a replacement for it.
    belowFloorStreak = 0;
    demoted = false;
  }
  return { ...cell, belowFloorStreak, demoted };
}

/**
 * A real dispatch attempt: increments `attempts`, updates the health EWMA
 * from the protocol-level outcome, and applies an inline penalty when this
 * SAME attempt was truncated or had a malformed tool call (0 for a clean
 * success/failure). Auto-recovery ("periodic single probe; success
 * restores" — BUILD_PLAN_V2 §4): a demoted entry stays reachable as an
 * ordinary chain-tail fallback, so real traffic doubles as the probe — one
 * healthy attempt clears `demoted` and resets the streak.
 */
export function applyAttempt(
  cell: ScoreCell,
  healthy: boolean,
  inlinePenalty: number,
  pin: number | undefined,
): ScoreCell {
  const next: ScoreCell = {
    health: updateHealth(cell.health, healthy, HEALTH_ALPHA),
    penalties: cell.penalties + inlinePenalty,
    attempts: cell.attempts + 1,
    belowFloorStreak: cell.belowFloorStreak,
    demoted: cell.demoted,
  };
  const reevaluated = reevaluateDemotion(next, pin);
  if (reevaluated.demoted && healthy) {
    return { ...reevaluated, belowFloorStreak: 0, demoted: false };
  }
  return reevaluated;
}

/**
 * A retroactive quality adjustment (escalation attribution, corrective
 * turn) — NOT a new dispatch attempt: `attempts` and `health` are untouched,
 * only `penalties` grows and demotion is re-checked against the unchanged
 * attempt count. Never triggers auto-recovery (it isn't a probe).
 */
export function applyPenalty(cell: ScoreCell, penalty: number, pin: number | undefined): ScoreCell {
  const next: ScoreCell = { ...cell, penalties: cell.penalties + penalty };
  return reevaluateDemotion(next, pin);
}

// ---- Opt-in corrective-turn heuristic (SPEC_V2 §9 — off by default; may be
// too noisy to trust, ships behind a config flag) ----

function messageText(content: AnthropicRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/**
 * True when the newest turn is from the user, directly follows an assistant
 * turn (not a tool_result continuation — those are user-role too, but aren't
 * the user "speaking"), and matches one of the declared corrective patterns.
 * Best-effort by design (SPEC_V2 §9): attribution uses the session's current
 * sticky entry as a proxy for "who answered last," not a stored per-turn
 * model log.
 */
export function isCorrectiveTurn(body: AnthropicRequest, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const messages = body.messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  if (typeof last.content !== 'string' && last.content.some((b) => b.type === 'tool_result')) {
    return false; // a tool-result continuation, not the user actually speaking
  }
  const text = messageText(last.content);
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}

// Compiled-pattern cache keyed by config version, same convention as
// privacy.ts's compiled-guard cache — per-request compilation is free.
let cachedVersion: string | undefined;
let cachedPatterns: RegExp[] = [];

export function compileQualityPatterns(cfg: RouterConfig): RegExp[] {
  if (cfg.version !== undefined && cfg.version === cachedVersion) return cachedPatterns;
  const patterns: RegExp[] = [];
  for (const p of cfg.quality?.corrective_patterns ?? []) {
    try {
      patterns.push(new RegExp(p, 'i'));
    } catch {
      console.log(`quality: invalid corrective_pattern skipped: ${p}`);
    }
  }
  cachedVersion = cfg.version;
  cachedPatterns = patterns;
  return patterns;
}
