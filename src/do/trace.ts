// M7 trace store (BUILD_PLAN_V2 §4): schema + pure ring-buffer/redaction logic,
// storage-backend-agnostic so it's testable without a Durable Object. KompassState
// (state.ts) owns the actual ctx.storage reads/writes around these functions —
// same split as router.ts (pure-ish orchestration) vs. state.ts (storage).
//
// Redaction is the default (guardrail §6.14): a trace record NEVER carries the
// raw request body unless the caller explicitly opted in (X-Kompass-Trace: full),
// and even then it's stored in a SEPARATE, TTL-bounded key — never mixed into the
// always-on ring buffer, so the redacted audit trail can never accidentally leak
// a raw prompt just by outliving its full-capture sibling's TTL differently.

export const TRACE_RING_SIZE = 500;
export const FULL_CAPTURE_TTL_MS = 60 * 60 * 1000; // 1h default (BUILD_PLAN_V2 §4)
// Defensive cap on stored raw_body size — SQLite-backed DO storage caps a single
// key+value at 2MB combined (verified live, developers.cloudflare.com/durable-objects/
// platform/limits/); 500KB leaves headroom for the rest of the record and other keys.
export const RAW_BODY_CAP = 500_000;

export interface TraceAttempt {
  model: string;
  outcome: 'ok' | 'fail';
  hop_reason: string;
  latency_ms?: number;
}

export interface TraceRecord {
  id: string;
  session?: string;
  ts: number;
  lane: string;
  /** Dispatcher verdict source: forced | heuristic | cache | classifier | fallback. */
  verdict: string;
  confidence?: number;
  est_in: number;
  chain_considered: string[];
  attempts: TraceAttempt[];
  final_model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Redaction (always present): a one-way fingerprint of the raw request text —
   *  lets an operator correlate repeat requests without ever storing the text. */
  digest: string;
  /** Opt-in only (X-Kompass-Trace: full): the raw request body, capped at
   *  RAW_BODY_CAP. Absent on every default (redacted) trace. */
  raw_body?: string;
  /** Present only alongside raw_body — epoch ms after which a full-capture
   *  record is considered expired (lazy-checked on read, never proactively
   *  swept — same convention as state.ts's putVerdict/getVerdict TTL). */
  exp?: number;
}

export function newTraceId(): string {
  return `trc_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** SHA-256 fingerprint of raw text, truncated to `len` hex chars — irreversible. */
export async function digestOf(rawText: string, len = 16): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawText));
  return [...new Uint8Array(hash)]
    .slice(0, len)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Append one record to the ring buffer, evicting the oldest past `max`. The
 * stored copy NEVER carries raw_body/exp — full-capture content lives only in
 * its own TTL-bounded key (see KompassState.writeTrace), so redaction can't be
 * defeated by the ring buffer outliving a full-capture entry's own TTL logic.
 */
export function pushTrace(
  ring: TraceRecord[],
  record: TraceRecord,
  max = TRACE_RING_SIZE,
): TraceRecord[] {
  const redacted: TraceRecord = {
    id: record.id,
    session: record.session,
    ts: record.ts,
    lane: record.lane,
    verdict: record.verdict,
    confidence: record.confidence,
    est_in: record.est_in,
    chain_considered: record.chain_considered,
    attempts: record.attempts,
    final_model: record.final_model,
    usage: record.usage,
    digest: record.digest,
  };
  return [...ring, redacted].slice(-max);
}

export function isExpired(record: { exp?: number }, now = Date.now()): boolean {
  return record.exp !== undefined && record.exp < now;
}
