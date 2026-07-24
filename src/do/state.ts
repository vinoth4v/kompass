// Durable Object holding all cross-machine shared state (SPEC §4):
// quota ledger (RPM/RPD per provider), model-health cooldowns, session stickiness,
// last-N route log. One instance ("global") backs every client machine, so two
// laptops draw down the same OpenRouter daily budget.
import { DurableObject } from 'cloudflare:workers';
import { isExpired, pushTrace, type TraceRecord } from './trace';

export interface ReserveLimits {
  rpm: number;
  rpd: number;
}

export type FailureKind = '429' | '5xx' | 'timeout' | 'stream-error';

export interface RouteRecord {
  ts: number;
  lane: string;
  entry: string;
  ok: boolean;
  ms?: number;
  session?: string;
  detail?: string;
  /** token usage (input/output) — attached post-hoc for streams */
  tin?: number;
  tout?: number;
}

interface TokenCell {
  day: string;
  tin: number;
  tout: number;
}

interface RpmCell {
  minute: number;
  count: number;
}
interface RpdCell {
  day: string;
  count: number;
}
interface StickyCell {
  entry: string;
  lane: string;
  ts: number;
}
interface PerfCell {
  ok: number;
  fail: number;
}

export interface ProviderDiscovery {
  liveCount: number;
  /** live models not referenced by any lane/dispatcher entry (capped) */
  unconfigured: string[];
  /** live models not present in the previous snapshot (capped) */
  newSinceLast: string[];
  error?: string;
}
export interface DiscoveryReport {
  ts: number;
  providers: Record<string, ProviderDiscovery>;
}

/** Per-day usage aggregates powering the status dashboard's analytics tab. */
export interface DayProviderStat {
  req: number;
  ok: number;
  tin: number;
  tout: number;
}
export interface DayHistory {
  providers: Record<string, DayProviderStat>;
  models: Record<string, { req: number; ok: number }>;
  lanes: Record<string, number>;
}

export const COOLDOWN_MS = 10 * 60 * 1000; // per-model health cooldown (SPEC P0 #5)
const STICKY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ROUTES = 50;
const HISTORY_DAYS = 60; // daily aggregates retained (covers this month + last)
const PERF_DECAY_CAP = 40; // halve ok/fail past this total so scoring stays recency-biased
const PERF_FLOOR = 0.05; // never fully zero out an entry — allow self-healing retries

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class KompassState extends DurableObject {
  private async rpm(provider: string): Promise<RpmCell> {
    return (await this.ctx.storage.get<RpmCell>(`rpm:${provider}`)) ?? { minute: 0, count: 0 };
  }

  private async rpd(provider: string): Promise<RpdCell> {
    return (await this.ctx.storage.get<RpdCell>(`rpd:${provider}`)) ?? { day: '', count: 0 };
  }

  /** Remaining quota without consuming any. */
  private async remaining(provider: string, limits: ReserveLimits, now: number) {
    const minute = Math.floor(now / 60_000);
    const day = utcDay(now);
    const m = await this.rpm(provider);
    const d = await this.rpd(provider);
    return {
      rpm: limits.rpm - (m.minute === minute ? m.count : 0),
      rpd: limits.rpd - (d.day === day ? d.count : 0),
    };
  }

  /** Weighted-random pick among a pool, weighted by each entry's recent success rate. */
  private async pickWeighted(pool: string[]): Promise<string> {
    if (pool.length <= 1) return pool[0]!;
    const weights: number[] = [];
    for (const entry of pool) {
      const perf = await this.ctx.storage.get<PerfCell>(`perf:${entry}`);
      const total = (perf?.ok ?? 0) + (perf?.fail ?? 0);
      // No data yet → optimistic weight 1 (give untested entries a fair first try).
      weights.push(total === 0 ? 1 : Math.max(PERF_FLOOR, perf!.ok / total));
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return pool[i]!;
    }
    return pool[pool.length - 1]!;
  }

  private async bumpPerf(entry: string, ok: boolean): Promise<void> {
    const key = `perf:${entry}`;
    const cur = (await this.ctx.storage.get<PerfCell>(key)) ?? { ok: 0, fail: 0 };
    let { ok: okC, fail: failC } = cur;
    if (ok) okC++;
    else failC++;
    if (okC + failC > PERF_DECAY_CAP) {
      okC = Math.floor(okC / 2);
      failC = Math.floor(failC / 2);
    }
    await this.ctx.storage.put(key, { ok: okC, fail: failC } satisfies PerfCell);
  }

  /**
   * Order a lane chain for one request: sticky entry first (if still viable),
   * exhausted-quota and cooling-down entries skipped up front (SPEC P0 #6).
   * `limitsByEntry` carries the config limits so the DO stays config-free.
   * When no sticky entry applies and `spreadTop` > 1, the first pick is drawn by
   * weighted-random from the top `spreadTop` viable candidates (weighted by recent
   * success rate) instead of always the highest-priority one — spreads load across
   * comparable models and adapts to which ones are actually performing well.
   */
  async filterChain(
    chain: string[],
    limitsByEntry: Record<string, { key: string; limits: ReserveLimits }>,
    sessionId?: string,
    spreadTop = 1,
  ): Promise<{ order: string[]; skipped: Array<{ entry: string; reason: string }> }> {
    const now = Date.now();
    const skipped: Array<{ entry: string; reason: string }> = [];
    const order: string[] = [];

    let sticky: string | undefined;
    if (sessionId) {
      const cell = await this.ctx.storage.get<StickyCell>(`sticky:${sessionId}`);
      if (cell && now - cell.ts < STICKY_TTL_MS && chain.includes(cell.entry)) {
        sticky = cell.entry;
      }
    }

    const candidates = sticky ? [sticky, ...chain.filter((e) => e !== sticky)] : [...chain];

    for (const entry of candidates) {
      const cool = await this.ctx.storage.get<number>(`cool:${entry}`);
      if (cool && cool > now) {
        skipped.push({ entry, reason: `cooldown ${Math.round((cool - now) / 1000)}s` });
        continue;
      }
      const cell = limitsByEntry[entry];
      if (cell) {
        const rem = await this.remaining(cell.key, cell.limits, now);
        if (rem.rpm <= 0) {
          skipped.push({ entry, reason: 'rpm exhausted' });
          continue;
        }
        if (rem.rpd <= 0) {
          skipped.push({ entry, reason: 'rpd exhausted' });
          continue;
        }
      }
      order.push(entry);
    }

    if (!sticky && spreadTop > 1 && order.length > 1) {
      const poolSize = Math.min(spreadTop, order.length);
      const chosen = await this.pickWeighted(order.slice(0, poolSize));
      if (chosen !== order[0]) {
        const rest = order.filter((e) => e !== chosen);
        order.length = 0;
        order.push(chosen, ...rest);
      }
    }

    return { order, skipped };
  }

  /**
   * Consume one request from a counter's RPM+RPD budget. `counterKey` is the
   * provider name, or "provider:model" when the config sets model_limits (so a
   * 50/day pro model doesn't share its window with a 1000/day flash model).
   * Returns false when the budget is gone (raced by another machine between
   * filterChain and now).
   */
  async reserve(
    counterKey: string,
    limits: ReserveLimits,
  ): Promise<{ ok: boolean; reason?: string }> {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const day = utcDay(now);

    const m = await this.rpm(counterKey);
    const mCount = m.minute === minute ? m.count : 0;
    if (mCount >= limits.rpm) return { ok: false, reason: 'rpm' };

    const d = await this.rpd(counterKey);
    const dCount = d.day === day ? d.count : 0;
    if (dCount >= limits.rpd) return { ok: false, reason: 'rpd' };

    await this.ctx.storage.put(`rpm:${counterKey}`, { minute, count: mCount + 1 });
    await this.ctx.storage.put(`rpd:${counterKey}`, { day, count: dCount + 1 });
    return { ok: true };
  }

  /**
   * Daily usage aggregate (one storage cell per UTC day, HISTORY_DAYS retention):
   * per-provider request/success/token counts, per-model request counts, per-lane
   * counts. Pruning happens on the first write of a fresh day — cheap and rare.
   */
  private async bumpHistory(
    entry: string,
    ok: boolean,
    lane?: string,
    usage?: { input_tokens: number; output_tokens: number },
  ): Promise<void> {
    const day = utcDay(Date.now());
    const key = `hist:${day}`;
    let cell = await this.ctx.storage.get<DayHistory>(key);
    if (!cell) {
      cell = { providers: {}, models: {}, lanes: {} };
      await this.pruneHistory(day);
    }
    const provider = entry.split('/')[0] ?? '';
    const p = (cell.providers[provider] ??= { req: 0, ok: 0, tin: 0, tout: 0 });
    p.req++;
    if (ok) p.ok++;
    if (usage) {
      p.tin += usage.input_tokens;
      p.tout += usage.output_tokens;
    }
    const m = (cell.models[entry] ??= { req: 0, ok: 0 });
    m.req++;
    if (ok) m.ok++;
    if (lane) cell.lanes[lane] = (cell.lanes[lane] ?? 0) + 1;
    await this.ctx.storage.put(key, cell);
  }

  private async pruneHistory(today: string): Promise<void> {
    const cutoff = utcDay(Date.parse(today) - HISTORY_DAYS * 86_400_000);
    const old = await this.ctx.storage.list({ prefix: 'hist:', end: `hist:${cutoff}` });
    for (const k of old.keys()) await this.ctx.storage.delete(k);
  }

  private async bumpTokens(provider: string, tin: number, tout: number): Promise<void> {
    const day = utcDay(Date.now());
    const cell = (await this.ctx.storage.get<TokenCell>(`tokd:${provider}`)) ?? {
      day,
      tin: 0,
      tout: 0,
    };
    const fresh = cell.day === day ? cell : { day, tin: 0, tout: 0 };
    await this.ctx.storage.put(`tokd:${provider}`, {
      day,
      tin: fresh.tin + tin,
      tout: fresh.tout + tout,
    });
  }

  /** Success: refresh stickiness + log. Failure: 10-min cooldown for the model + log. */
  async reportOutcome(
    entry: string,
    ok: boolean,
    opts: {
      kind?: FailureKind;
      sessionId?: string;
      lane?: string;
      ms?: number;
      detail?: string;
      usage?: { input_tokens: number; output_tokens: number };
    } = {},
  ): Promise<void> {
    const now = Date.now();
    await this.bumpPerf(entry, ok);
    if (ok) {
      if (opts.sessionId) {
        await this.ctx.storage.put(`sticky:${opts.sessionId}`, {
          entry,
          lane: opts.lane ?? '',
          ts: now,
        } satisfies StickyCell);
      }
    } else {
      await this.ctx.storage.put(`cool:${entry}`, now + COOLDOWN_MS);
      // If this session was stuck to the failing model, unstick it so the next
      // turn re-plans instead of looping on a broken provider.
      if (opts.sessionId) {
        const cell = await this.ctx.storage.get<StickyCell>(`sticky:${opts.sessionId}`);
        if (cell?.entry === entry) await this.ctx.storage.delete(`sticky:${opts.sessionId}`);
      }
    }
    const routes = (await this.ctx.storage.get<RouteRecord[]>('routes')) ?? [];
    routes.push({
      ts: now,
      lane: opts.lane ?? '',
      entry,
      ok,
      ms: opts.ms,
      session: opts.sessionId?.slice(-12),
      detail: ok ? undefined : (opts.kind ?? 'error') + (opts.detail ? `: ${opts.detail}` : ''),
      tin: opts.usage?.input_tokens,
      tout: opts.usage?.output_tokens,
    });
    await this.ctx.storage.put('routes', routes.slice(-MAX_ROUTES));
    await this.bumpHistory(entry, ok, opts.lane, opts.usage);
    if (opts.usage) {
      await this.bumpTokens(
        entry.split('/')[0] ?? '',
        opts.usage.input_tokens,
        opts.usage.output_tokens,
      );
    }
  }

  /**
   * Late usage report for live-streamed responses (router.ts live path): token
   * counts are only known at stream end, after reportOutcome already logged the
   * route. Bumps the provider token counters and back-fills the newest matching
   * route record so the status page shows real numbers.
   */
  async recordUsage(
    entry: string,
    usage: { input_tokens: number; output_tokens: number },
  ): Promise<void> {
    await this.bumpTokens(entry.split('/')[0] ?? '', usage.input_tokens, usage.output_tokens);
    // Late token counts also land in today's history aggregate (request/success
    // were already counted by reportOutcome — only tokens are added here).
    {
      const day = utcDay(Date.now());
      const key = `hist:${day}`;
      const cell = (await this.ctx.storage.get<DayHistory>(key)) ?? {
        providers: {},
        models: {},
        lanes: {},
      };
      const provider = entry.split('/')[0] ?? '';
      const p = (cell.providers[provider] ??= { req: 0, ok: 0, tin: 0, tout: 0 });
      p.tin += usage.input_tokens;
      p.tout += usage.output_tokens;
      await this.ctx.storage.put(key, cell);
    }
    const routes = (await this.ctx.storage.get<RouteRecord[]>('routes')) ?? [];
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (r && r.entry === entry && r.ok && r.tin === undefined) {
        r.tin = usage.input_tokens;
        r.tout = usage.output_tokens;
        await this.ctx.storage.put('routes', routes);
        break;
      }
    }
  }

  /** M3 verdict cache: classifier verdicts keyed by task-digest hash, TTL-bound. */
  async getVerdict(key: string): Promise<{ lane: string; confidence: number } | null> {
    const cell = await this.ctx.storage.get<{ lane: string; confidence: number; exp: number }>(
      `verdict:${key}`,
    );
    if (!cell || cell.exp < Date.now()) return null;
    return { lane: cell.lane, confidence: cell.confidence };
  }

  async putVerdict(
    key: string,
    verdict: { lane: string; confidence: number },
    ttlSeconds: number,
  ): Promise<void> {
    await this.ctx.storage.put(`verdict:${key}`, {
      ...verdict,
      exp: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * M5 escalation counter: consecutive failed tool iterations per session.
   * hadError=true increments and returns the new count; false resets to 0.
   */
  async bumpToolErrors(sessionId: string, hadError: boolean): Promise<number> {
    const k = `toolerr:${sessionId}`;
    if (!hadError) {
      await this.ctx.storage.delete(k);
      return 0;
    }
    const count = ((await this.ctx.storage.get<number>(k)) ?? 0) + 1;
    await this.ctx.storage.put(k, count);
    return count;
  }

  async resetToolErrors(sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`toolerr:${sessionId}`);
  }

  /** Drop stickiness for a session (used on lane escalation / explicit model switch). */
  async releaseSticky(sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`sticky:${sessionId}`);
  }

  /** Raw state for /status: counters, cooldowns, token totals, perf, recent routes. */
  async snapshot(): Promise<{
    rpm: Record<string, RpmCell>;
    rpd: Record<string, RpdCell>;
    cooldowns: Record<string, number>;
    tokens: Record<string, TokenCell>;
    perf: Record<string, PerfCell>;
    routes: RouteRecord[];
    history: Record<string, DayHistory>;
  }> {
    const now = Date.now();
    const rpm: Record<string, RpmCell> = {};
    const rpd: Record<string, RpdCell> = {};
    const cooldowns: Record<string, number> = {};
    const tokens: Record<string, TokenCell> = {};
    const perf: Record<string, PerfCell> = {};
    const history: Record<string, DayHistory> = {};
    const all = await this.ctx.storage.list();
    for (const [k, v] of all) {
      if (k.startsWith('rpm:')) rpm[k.slice(4)] = v as RpmCell;
      else if (k.startsWith('rpd:')) rpd[k.slice(4)] = v as RpdCell;
      else if (k.startsWith('tokd:')) tokens[k.slice(5)] = v as TokenCell;
      else if (k.startsWith('perf:')) perf[k.slice(5)] = v as PerfCell;
      else if (k.startsWith('hist:')) history[k.slice(5)] = v as DayHistory;
      else if (k.startsWith('cool:') && (v as number) > now) cooldowns[k.slice(5)] = v as number;
    }
    return {
      rpm,
      rpd,
      cooldowns,
      tokens,
      perf,
      routes: (await this.ctx.storage.get<RouteRecord[]>('routes')) ?? [],
      history,
    };
  }

  // ── M-discovery: scheduled model-roster checking (never auto-mutates config) ──

  async getRosterSnapshot(provider: string): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(`roster:${provider}`)) ?? [];
  }

  async setRosterSnapshot(provider: string, roster: string[]): Promise<void> {
    await this.ctx.storage.put(`roster:${provider}`, roster);
  }

  async recordDiscovery(report: DiscoveryReport): Promise<void> {
    await this.ctx.storage.put('discovery', report);
  }

  async getDiscovery(): Promise<DiscoveryReport | null> {
    return (await this.ctx.storage.get<DiscoveryReport>('discovery')) ?? null;
  }

  /**
   * Test/admin helper: directly set an entry's perf counters, bypassing the
   * cooldown/routes side effects reportOutcome would trigger on a real failure.
   */
  async seedPerf(entry: string, ok: number, fail: number): Promise<void> {
    await this.ctx.storage.put(`perf:${entry}`, { ok, fail } satisfies PerfCell);
  }

  /**
   * Test/admin helper: consume (or with negative n, restore) requests of a
   * provider's daily budget. Lets the deployed smoke prove exhaustion-fallback
   * and then undo the damage.
   */
  async burn(provider: string, n: number): Promise<{ day: string; count: number }> {
    const now = Date.now();
    const day = utcDay(now);
    const d = await this.rpd(provider);
    const count = Math.max(0, (d.day === day ? d.count : 0) + n);
    await this.ctx.storage.put(`rpd:${provider}`, { day, count });
    return { day, count };
  }

  // ── M7 trace store: DO-storage ring buffer + opt-in TTL-bounded full capture ──
  // (SPEC_V2 §9 — confirmed live against a 500-entry buffer: SQLite-backed DO
  // storage is 5GB/account on the free plan, 2MB per key+value, 100k rows
  // written/day; the buffer's one array-under-one-key write is 1 row, matching
  // the existing `routes` pattern, so a 500-entry ring buffer plus the ~5
  // existing per-request writes stays well inside the free daily row budget.
  // See docs/DECISIONS.md.)

  /**
   * Fire-and-forget from the caller (ctx.waitUntil) — never awaited on the
   * response path. Always appends a redacted summary to the ring buffer;
   * additionally writes a separate TTL-bounded full-capture key only when the
   * caller opted in (record.raw_body present).
   */
  async writeTrace(record: TraceRecord): Promise<void> {
    const ring = (await this.ctx.storage.get<TraceRecord[]>('traces')) ?? [];
    await this.ctx.storage.put('traces', pushTrace(ring, record));
    if (record.raw_body !== undefined) {
      await this.ctx.storage.put(`tracefull:${record.id}`, {
        raw_body: record.raw_body,
        exp: record.exp,
      });
    }
  }

  /** Redacted summary, enriched with raw_body when an unexpired full-capture
   *  key exists for this id. Null when the id isn't in the ring buffer at all
   *  (evicted, or never existed). */
  async getTrace(id: string): Promise<TraceRecord | null> {
    const ring = (await this.ctx.storage.get<TraceRecord[]>('traces')) ?? [];
    const base = ring.find((t) => t.id === id) ?? null;
    if (!base) return null;
    const full = await this.ctx.storage.get<{ raw_body: string; exp?: number }>(`tracefull:${id}`);
    if (full && !isExpired(full)) return { ...base, raw_body: full.raw_body, exp: full.exp };
    return base;
  }

  /** Newest-first, always redacted (never raw_body) — a lightweight overview,
   *  distinct from the single-trace fetch above which may reveal raw_body. */
  async listTraces(n: number): Promise<TraceRecord[]> {
    const ring = (await this.ctx.storage.get<TraceRecord[]>('traces')) ?? [];
    return ring.slice(-n).reverse();
  }
}
