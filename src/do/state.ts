// Durable Object holding all cross-machine shared state (SPEC §4):
// quota ledger (RPM/RPD per provider), model-health cooldowns, session stickiness,
// last-N route log. One instance ("global") backs every client machine, so two
// laptops draw down the same OpenRouter daily budget.
import { DurableObject } from 'cloudflare:workers';

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

export const COOLDOWN_MS = 10 * 60 * 1000; // per-model health cooldown (SPEC P0 #5)
const STICKY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ROUTES = 50;

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

  /**
   * Order a lane chain for one request: sticky entry first (if still viable),
   * exhausted-quota and cooling-down entries skipped up front (SPEC P0 #6).
   * `limitsByEntry` carries the config limits so the DO stays config-free.
   */
  async filterChain(
    chain: string[],
    limitsByEntry: Record<string, { key: string; limits: ReserveLimits }>,
    sessionId?: string,
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
    if (opts.usage) {
      await this.bumpTokens(
        entry.split('/')[0] ?? '',
        opts.usage.input_tokens,
        opts.usage.output_tokens,
      );
    }
  }

  /**
   * Streaming responses only learn their token usage at stream end — attach it to
   * the most recent matching route record after the fact.
   */
  async attachUsage(
    entry: string,
    usage: { input_tokens: number; output_tokens: number },
  ): Promise<void> {
    const routes = (await this.ctx.storage.get<RouteRecord[]>('routes')) ?? [];
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i]!;
      if (r.entry === entry && r.ok && r.tin === undefined) {
        r.tin = usage.input_tokens;
        r.tout = usage.output_tokens;
        await this.ctx.storage.put('routes', routes);
        break;
      }
    }
    await this.bumpTokens(entry.split('/')[0] ?? '', usage.input_tokens, usage.output_tokens);
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

  /** Raw state for /status: counters, cooldowns, token totals, recent routes. */
  async snapshot(): Promise<{
    rpm: Record<string, RpmCell>;
    rpd: Record<string, RpdCell>;
    cooldowns: Record<string, number>;
    tokens: Record<string, TokenCell>;
    routes: RouteRecord[];
  }> {
    const now = Date.now();
    const rpm: Record<string, RpmCell> = {};
    const rpd: Record<string, RpdCell> = {};
    const cooldowns: Record<string, number> = {};
    const tokens: Record<string, TokenCell> = {};
    const all = await this.ctx.storage.list();
    for (const [k, v] of all) {
      if (k.startsWith('rpm:')) rpm[k.slice(4)] = v as RpmCell;
      else if (k.startsWith('rpd:')) rpd[k.slice(4)] = v as RpdCell;
      else if (k.startsWith('tokd:')) tokens[k.slice(5)] = v as TokenCell;
      else if (k.startsWith('cool:') && (v as number) > now) cooldowns[k.slice(5)] = v as number;
    }
    return {
      rpm,
      rpd,
      cooldowns,
      tokens,
      routes: (await this.ctx.storage.get<RouteRecord[]>('routes')) ?? [],
    };
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
}
