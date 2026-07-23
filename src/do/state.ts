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
    limitsByEntry: Record<string, ReserveLimits>,
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
      const limits = limitsByEntry[entry];
      if (limits) {
        const rem = await this.remaining(entry.split('/')[0] ?? '', limits, now);
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
   * Consume one request from a provider's RPM+RPD budget. Returns false when the
   * budget is gone (raced by another machine between filterChain and now).
   */
  async reserve(
    provider: string,
    limits: ReserveLimits,
  ): Promise<{ ok: boolean; reason?: string }> {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const day = utcDay(now);

    const m = await this.rpm(provider);
    const mCount = m.minute === minute ? m.count : 0;
    if (mCount >= limits.rpm) return { ok: false, reason: 'rpm' };

    const d = await this.rpd(provider);
    const dCount = d.day === day ? d.count : 0;
    if (dCount >= limits.rpd) return { ok: false, reason: 'rpd' };

    await this.ctx.storage.put(`rpm:${provider}`, { minute, count: mCount + 1 });
    await this.ctx.storage.put(`rpd:${provider}`, { day, count: dCount + 1 });
    return { ok: true };
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
    });
    await this.ctx.storage.put('routes', routes.slice(-MAX_ROUTES));
  }

  /** Drop stickiness for a session (used on lane escalation / explicit model switch). */
  async releaseSticky(sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`sticky:${sessionId}`);
  }

  /** Raw state for /status: counters, cooldowns, recent routes. */
  async snapshot(): Promise<{
    rpm: Record<string, RpmCell>;
    rpd: Record<string, RpdCell>;
    cooldowns: Record<string, number>;
    routes: RouteRecord[];
  }> {
    const now = Date.now();
    const rpm: Record<string, RpmCell> = {};
    const rpd: Record<string, RpdCell> = {};
    const cooldowns: Record<string, number> = {};
    const all = await this.ctx.storage.list();
    for (const [k, v] of all) {
      if (k.startsWith('rpm:')) rpm[k.slice(4)] = v as RpmCell;
      else if (k.startsWith('rpd:')) rpd[k.slice(4)] = v as RpdCell;
      else if (k.startsWith('cool:') && (v as number) > now) cooldowns[k.slice(5)] = v as number;
    }
    return {
      rpm,
      rpd,
      cooldowns,
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
