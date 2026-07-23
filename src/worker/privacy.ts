// M5 privacy guard (SPEC P1 #8): requests whose content matches configured secret
// patterns or path globs are never sent to providers flagged trains_on_data: true.
// CPU note (error 1102): the guard runs ONE combined regex over the raw request
// text — never per-pattern passes over a re-serialized body. Claude Code contexts
// reach megabytes, and the free Workers plan allows ~10ms CPU per request.
import type { RouterConfig } from './config';

/**
 * Minimal glob → RegExp source: '*' matches within a path segment, '**' across
 * segments. CRITICAL: never emit unbounded `.*` — a leading `.*` makes .test()
 * O(n²) via backtracking, which alone blew the 10ms CPU budget on ~100KB Claude
 * Code payloads (the original error-1102 trigger). Leading/trailing globstars are
 * redundant for an unanchored search and are stripped; interior ones become a
 * bounded character class that cannot cross whitespace or JSON string quotes.
 */
export function globToRegExpSource(glob: string): string {
  let g = glob;
  if (g.startsWith('**/')) g = g.slice(2); // '**/x' → '/x' (unanchored search does the rest)
  if (g.endsWith('/**')) g = g.slice(0, -2); // 'x/**' → 'x/'
  return g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', ' ')
    .replaceAll('*', '[^/\\s"\']*')
    .replaceAll(' ', '[^\\s"\']*')
    .replaceAll('?', '.');
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(globToRegExpSource(glob));
}

export interface PrivacyGuard {
  combined: RegExp;
}

// Compiled-guard cache keyed by config version so per-request compilation is free.
let cachedVersion: string | undefined;
let cachedGuard: PrivacyGuard | null = null;

export function compilePrivacyGuard(cfg: RouterConfig): PrivacyGuard | null {
  if (cfg.version !== undefined && cfg.version === cachedVersion) return cachedGuard;
  const p = cfg.privacy;
  const sources: string[] = [];
  for (const re of p?.block_patterns ?? []) {
    try {
      new RegExp(re); // validate individually so one bad pattern doesn't kill the rest
      sources.push(`(?:${re})`);
    } catch {
      console.log(`privacy: invalid regex skipped: ${re}`);
    }
  }
  for (const glob of p?.block_globs ?? []) sources.push(`(?:${globToRegExpSource(glob)})`);
  const guard = sources.length ? { combined: new RegExp(sources.join('|')) } : null;
  cachedVersion = cfg.version;
  cachedGuard = guard;
  return guard;
}

/** True when any configured pattern appears in the raw request text (single pass). */
export function privacyMatch(guard: PrivacyGuard, rawRequestText: string): boolean {
  return guard.combined.test(rawRequestText);
}
