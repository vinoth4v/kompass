// Automatic council composition.
//
// Asking the user to pick the seats was a design mistake. Nobody can know from
// a dropdown that minimax-m3 answers in 30.2s while nemotron-3-super answers in
// 3.0s at a higher success rate, or that five OpenRouter models share ONE 20/min
// quota bucket and will starve each other. The first hand-picked run proved it:
// five seats, two of them FAST-lane models, most on the same provider — every
// seat came back exhausted.
//
// The gateway already knows all of this. /status carries live cooldowns, per
// provider quota headroom, measured success rate per model, and the latency of
// every recent route. So the council composes itself from evidence, and shows
// its reasoning instead of asking.
//
// The single most important rule here is PROVIDER DIVERSITY. Reliability and
// speed pick good models; provider diversity is what stops them competing for
// the same rate limit — and it is the constraint a human picker is least likely
// to think about.

export interface StatusSnapshot {
  lanes?: Record<string, { chain: string[] }>;
  perf?: Record<string, { ok: number; fail: number; rate: number }>;
  cooldowns?: Record<string, string>;
  disabled_models?: string[];
  routes?: { entry: string; ok: boolean; ms?: number }[];
  providers?: Record<
    string,
    {
      enabled: boolean;
      has_key: boolean;
      rpm: { used: number; limit: number };
      rpd: { used: number; limit: number };
    }
  >;
}

export interface PlannedSeat {
  model: string;
  label: string;
  /** Shown in the UI: why this model earned a seat. */
  why: string;
}

export interface CouncilPlan {
  seats: PlannedSeat[];
  judge: PlannedSeat;
  /** Caveats worth showing — degraded pools, thin evidence, etc. */
  notes: string[];
}

/** Lanes whose members are tool-capable enough to run a research loop. FAST and
 *  SIMPLE entries are excluded: they are small models on tight token ceilings,
 *  and two of them were seated by hand in the run that failed. */
const RESEARCH_LANES = ['AGENTIC', 'HARD', 'LONGCTX'];

const SEAT_NAMES = ['Analyst A', 'Analyst B', 'Analyst C', 'Analyst D', 'Analyst E'];

function providerOf(entry: string): string {
  return entry.split('/')[0] ?? entry;
}

/** Median latency per entry from the gateway's own recent successful routes. */
function latencyIndex(routes: StatusSnapshot['routes']): Map<string, number> {
  const byEntry = new Map<string, number[]>();
  for (const r of routes ?? []) {
    if (!r.ok || typeof r.ms !== 'number') continue;
    const list = byEntry.get(r.entry) ?? [];
    list.push(r.ms);
    byEntry.set(r.entry, list);
  }
  const out = new Map<string, number>();
  for (const [entry, list] of byEntry) {
    list.sort((a, b) => a - b);
    out.set(entry, list[Math.floor(list.length / 2)]!);
  }
  return out;
}

interface Candidate {
  entry: string;
  provider: string;
  rate: number;
  samples: number;
  medianMs?: number;
  score: number;
  why: string;
}

/**
 * Compose a council from live gateway state.
 *
 * `desiredSeats` is a ceiling, not a target: if only two providers have healthy
 * capacity right now, seating four models from one of them would be worse than
 * seating two. A smaller council that answers beats a larger one that starves.
 */
export function planCouncil(status: StatusSnapshot, desiredSeats = 3): CouncilPlan {
  const notes: string[] = [];
  const disabled = new Set(status.disabled_models ?? []);
  const cooling = new Set(Object.keys(status.cooldowns ?? {}));
  const latency = latencyIndex(status.routes);

  // Pool: tool-capable lanes only, de-duplicated across lanes.
  const pool = new Set<string>();
  for (const lane of RESEARCH_LANES) {
    for (const entry of status.lanes?.[lane]?.chain ?? []) pool.add(entry);
  }

  let skippedCooling = 0;
  let skippedQuota = 0;
  const candidates: Candidate[] = [];

  for (const entry of pool) {
    if (disabled.has(entry)) continue;
    if (cooling.has(entry)) {
      skippedCooling++;
      continue;
    }
    const provider = providerOf(entry);
    const p = status.providers?.[provider];
    if (!p || !p.enabled || !p.has_key) continue;
    // Availability: a provider already at its daily or minute ceiling cannot
    // seat anyone, no matter how good its models are.
    if (p.rpd.limit > 0 && p.rpd.used >= p.rpd.limit) {
      skippedQuota++;
      continue;
    }
    if (p.rpm.limit > 0 && p.rpm.used >= p.rpm.limit) {
      skippedQuota++;
      continue;
    }

    const perf = status.perf?.[entry];
    const samples = perf ? perf.ok + perf.fail : 0;
    // Unproven models are treated as average rather than good or bad — a 100%
    // rate over 2 requests is not evidence.
    const rate = perf && samples >= 3 ? perf.rate : 75;
    const medianMs = latency.get(entry);

    // Reliability dominates; latency is a real but secondary cost. A model with
    // no timing data is not penalised — it is simply unproven, not slow.
    let score = rate;
    if (medianMs !== undefined) {
      score -= Math.min(25, (medianMs / 1000) * 1.2);
    }
    if (samples < 3) score -= 8;

    const bits: string[] = [];
    bits.push(samples >= 3 ? `${rate}% over ${samples}` : 'no track record yet');
    if (medianMs !== undefined) bits.push(`${(medianMs / 1000).toFixed(1)}s median`);
    candidates.push({ entry, provider, rate, samples, medianMs, score, why: bits.join(' · ') });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Greedy pick, at most one per provider: seats on the same provider share one
  // rate-limit bucket and starve each other under parallel load.
  const seats: PlannedSeat[] = [];
  const usedProviders = new Set<string>();
  for (const c of candidates) {
    if (seats.length >= desiredSeats) break;
    if (usedProviders.has(c.provider)) continue;
    usedProviders.add(c.provider);
    seats.push({
      model: c.entry,
      label: SEAT_NAMES[seats.length] ?? `Analyst ${seats.length + 1}`,
      why: `${c.why} · own quota pool (${c.provider})`,
    });
  }

  if (seats.length === 0) {
    // Nothing healthy: fall back to lane routing and let the gateway decide,
    // rather than refusing to convene at all.
    notes.push(
      'No model currently has healthy capacity — falling back to automatic lane routing. ' +
        'Expect failures until quotas or cooldowns recover.',
    );
    return {
      seats: [{ model: 'kompass-agentic', label: 'Analyst A', why: 'fallback: lane routing' }],
      judge: { model: 'kompass-hard', label: 'Judge', why: 'fallback: lane routing' },
      notes,
    };
  }

  if (seats.length < desiredSeats) {
    notes.push(
      `Seated ${seats.length} of ${desiredSeats} requested: only ${usedProviders.size} provider${
        usedProviders.size === 1 ? '' : 's'
      } has healthy capacity right now. A smaller council that answers beats a larger one that starves.`,
    );
  }
  if (skippedCooling > 0) {
    notes.push(`${skippedCooling} model${skippedCooling === 1 ? '' : 's'} skipped — cooling down.`);
  }
  if (skippedQuota > 0) {
    notes.push(`${skippedQuota} skipped — provider quota spent for now.`);
  }

  // Judge: the strongest remaining model, ideally NOT one of the seats so it
  // reads the debate rather than re-reading its own answer. Falls back to the
  // best seat's model if nothing else is healthy.
  const judgeCandidate =
    candidates.find((c) => !seats.some((s) => s.model === c.entry)) ?? candidates[0];
  const judge: PlannedSeat = judgeCandidate
    ? {
        model: judgeCandidate.entry,
        label: 'Judge',
        why: `${judgeCandidate.why}${
          seats.some((s) => s.model === judgeCandidate.entry)
            ? ' · also seated (no independent model available)'
            : ' · independent of the seats'
        }`,
      }
    : { model: 'kompass-hard', label: 'Judge', why: 'fallback: lane routing' };

  return { seats, judge, notes };
}
