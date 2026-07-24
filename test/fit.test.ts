// M6 acceptance (BUILD_PLAN_V2 §4): fit-filter unit tests, EWMA calibration,
// backward-compat regression, CPU-cost measurement, and integration tests for
// the skip-too-large path, privacy-before-fit ordering, and the "fits
// nothing" synthetic notice.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { heuristicLane, longctxThreshold } from '../src/worker/dispatcher';
import { noFitNoticeText } from '../src/worker/escalation';
import {
  checkFit,
  currentRatio,
  estimateInputTokens,
  filterChainByFit,
  largestCtx,
  recordActualTokens,
  resetRatios,
  smallestCtx,
} from '../src/worker/fit';
import type { AnthropicRequest } from '../src/adapters/types';
import type { RouterConfig } from '../src/worker/config';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-bearer-token',
};

// ---- fixtures ----

function fitCfg(): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      small: {
        kind: 'openai',
        base_url: 'https://small.test/v1',
        key_env: 'SMALL_KEY',
        limits: { rpm: 100, rpd: 5000 },
        model_limits: { 'model-a': { rpm: 100, rpd: 5000, ctx: 8000 } },
      },
      big: {
        kind: 'openai',
        base_url: 'https://big.test/v1',
        key_env: 'BIG_KEY',
        limits: { rpm: 100, rpd: 5000 },
        model_limits: { 'model-b': { rpm: 100, rpd: 5000, ctx: 1_000_000 } },
      },
      unknown: {
        kind: 'openai',
        base_url: 'https://unknown.test/v1',
        key_env: 'UNKNOWN_KEY',
        limits: { rpm: 100, rpd: 5000 },
      },
      tpmLimited: {
        kind: 'openai',
        base_url: 'https://tpm.test/v1',
        key_env: 'TPM_KEY',
        limits: { rpm: 100, rpd: 5000, tpm: 5000 },
      },
    },
    lanes: {
      AGENTIC: ['small/model-a', 'big/model-b', 'unknown/model-c'],
    },
  };
}

// ---- unit: checkFit ----

describe('checkFit (unit)', () => {
  it('fits when need <= ctx', () => {
    const c = checkFit(fitCfg(), 'small/model-a', 400, 100); // tiny body
    expect(c.fits).toBe(true);
    expect(c.ctx).toBe(8000);
  });

  it('does not fit when need > ctx — reason "ctx", numbers reported', () => {
    // 8000-ratio-3.6 bytes ~ way more tokens than the 8000-token ctx allows.
    const c = checkFit(fitCfg(), 'small/model-a', 100_000, 4096);
    expect(c.fits).toBe(false);
    expect(c.reason).toBe('ctx');
    expect(c.ctx).toBe(8000);
    expect(c.estIn).toBeGreaterThan(0);
    expect(c.need).toBeGreaterThan(8000);
  });

  it('unknown ctx never hard-drops, regardless of size', () => {
    const c = checkFit(fitCfg(), 'unknown/model-c', 5_000_000, 100_000);
    expect(c.fits).toBe(true);
    expect(c.ctx).toBeUndefined();
  });

  it('tpm bound trips independently of ctx', () => {
    const c = checkFit(fitCfg(), 'tpmLimited/anything', 100_000, 100);
    expect(c.fits).toBe(false);
    expect(c.reason).toBe('tpm');
    expect(c.tpm).toBe(5000);
  });

  it('max_out caps the requested max_tokens in the need calculation', () => {
    const cfg = fitCfg();
    cfg.providers.small!.model_limits!['model-a'] = {
      rpm: 100,
      rpd: 5000,
      ctx: 8000,
      max_out: 500,
    };
    // Request asks for 100k max_tokens, but model_limits caps effective max_out
    // at 500 — need should reflect the cap, not the raw request.
    const capped = checkFit(cfg, 'small/model-a', 400, 100_000);
    const uncapped = checkFit(fitCfg(), 'small/model-a', 400, 100_000);
    expect(capped.need).toBeLessThan(uncapped.need);
  });
});

// ---- unit: filterChainByFit ----

describe('filterChainByFit (unit)', () => {
  it('drops known-too-large entries, keeps + ranks unknown-ctx entries last', () => {
    const cfg = fitCfg();
    const chain = ['small/model-a', 'big/model-b', 'unknown/model-c'];
    const result = filterChainByFit(cfg, chain, 100_000, 4096); // too big for small/model-a
    expect(result.order).toEqual(['big/model-b', 'unknown/model-c']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.entry).toBe('small/model-a');
    expect(result.skipped[0]!.detail).toMatch(/est_in=\d+ need=\d+ ctx=8000/);
  });

  it('small request: known entries keep relative order, unknown sinks to the end', () => {
    const cfg = fitCfg();
    const chain = ['small/model-a', 'big/model-b', 'unknown/model-c'];
    const result = filterChainByFit(cfg, chain, 400, 100);
    expect(result.order).toEqual(['small/model-a', 'big/model-b', 'unknown/model-c']);
    expect(result.skipped).toEqual([]);
  });

  it('backward-compat regression: no ctx/tpm/default_ctx anywhere → output order equals input, unconditionally', () => {
    const cfg: RouterConfig = {
      default_lane: 'AGENTIC',
      allow_paid: false,
      providers: {
        openrouter: {
          kind: 'openai',
          base_url: 'https://openrouter.ai/api/v1',
          key_env: 'OPENROUTER_API_KEY',
          limits: { rpm: 20, rpd: 1000 },
        },
      },
      lanes: { AGENTIC: ['openrouter/a:free', 'openrouter/b:free', 'openrouter/c:free'] },
    };
    const chain = ['openrouter/a:free', 'openrouter/b:free', 'openrouter/c:free'];
    // Even a 200k-char request changes nothing: every entry is "unknown".
    const result = filterChainByFit(cfg, chain, 200_000, 4096);
    expect(result.order).toEqual(chain);
    expect(result.skipped).toEqual([]);
  });
});

// ---- unit: largestCtx / smallestCtx ----

describe('largestCtx / smallestCtx (unit)', () => {
  it('computes across a chain, ignoring unknown entries', () => {
    const cfg = fitCfg();
    const chain = ['small/model-a', 'big/model-b', 'unknown/model-c'];
    expect(largestCtx(cfg, chain)).toBe(1_000_000);
    expect(smallestCtx(cfg, chain)).toBe(8000);
  });

  it('undefined when no entry declares a ctx', () => {
    const cfg = fitCfg();
    expect(largestCtx(cfg, ['unknown/model-c'])).toBeUndefined();
    expect(smallestCtx(cfg, ['unknown/model-c'])).toBeUndefined();
  });
});

// ---- unit: EWMA calibration ----

describe('estimator calibration (unit)', () => {
  it('seeds at 3.6 bytes/token before any calibration', () => {
    resetRatios();
    expect(currentRatio('fresh-provider')).toBe(3.6);
  });

  it('converges within 15% of the true ratio after 50 real requests', () => {
    resetRatios();
    const provider = 'calibrated';
    const bytes = 10_000;
    const trueTokens = 2500; // true ratio 4.0, seed is 3.6
    for (let i = 0; i < 50; i++) recordActualTokens(provider, bytes, trueTokens);
    const estimated = estimateInputTokens(provider, bytes);
    const pctError = Math.abs(estimated - trueTokens) / trueTokens;
    expect(pctError).toBeLessThan(0.15);
  });

  it('ratio is per-provider — calibrating one never moves another', () => {
    resetRatios();
    recordActualTokens('provider-x', 10_000, 1000); // pushes ratio toward 10.0
    expect(currentRatio('provider-y')).toBe(3.6);
  });

  it('ignores zero/negative inputs (no divide-by-zero corruption)', () => {
    resetRatios();
    recordActualTokens('guarded', 0, 100);
    recordActualTokens('guarded', 100, 0);
    expect(currentRatio('guarded')).toBe(3.6);
  });
});

// ---- CPU cost measurement (BUILD_PLAN_V2 §4 acceptance) ----

describe('fit filter CPU cost (measured, not assumed)', () => {
  it('adds well under 1ms on a 400KB body', () => {
    const cfg = fitCfg();
    // A realistic-width chain: 10 entries, mixed known/unknown ctx.
    const chain = [
      'small/model-a',
      'big/model-b',
      'unknown/model-c',
      'small/model-a',
      'big/model-b',
      'unknown/model-c',
      'small/model-a',
      'big/model-b',
      'unknown/model-c',
      'small/model-a',
    ];
    const bodyBytes = 400 * 1024;
    const iterations = 200;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) filterChainByFit(cfg, chain, bodyBytes, 4096);
    const perCallMs = (performance.now() - t0) / iterations;
    console.log(`[M6] fit filter: ${perCallMs.toFixed(4)}ms/call on a 400KB body, 10-entry chain`);
    expect(perCallMs).toBeLessThan(1);
  });
});

// ---- LONGCTX heuristic threshold derivation ----

describe('LONGCTX heuristic threshold (unit)', () => {
  const base: AnthropicRequest = {
    model: 'm',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'x' }],
  };

  it('falls back to 60k when no cfg or no AGENTIC ctx declared', () => {
    expect(longctxThreshold()).toBe(60_000);
    const cfg = fitCfg();
    cfg.lanes.AGENTIC = ['unknown/model-c'];
    expect(longctxThreshold(cfg)).toBe(60_000);
  });

  it('derives from the smallest declared ctx in the AGENTIC chain', () => {
    const cfg = fitCfg();
    cfg.lanes.AGENTIC = ['small/model-a', 'big/model-b']; // smallest ctx = 8000
    expect(longctxThreshold(cfg)).toBe(8000);
  });

  it('heuristicLane uses the derived threshold instead of the hardcoded 60k', () => {
    const cfg = fitCfg();
    cfg.lanes.AGENTIC = ['small/model-a']; // ctx 8000 tokens ≈ 28,800 chars
    const big = {
      ...base,
      // ~10,000 tokens (chars/4 estimate): well under the old 60k line, over the derived 8000 one.
      messages: [{ role: 'user' as const, content: 'x'.repeat(40_000) }],
    };
    expect(heuristicLane(big, undefined, cfg)).toBe('LONGCTX');
    // Same request against an unmodified v1-style cfg (no ctx anywhere) stays under the old 60k line.
    const v1Cfg = fitCfg();
    v1Cfg.lanes.AGENTIC = ['unknown/model-c'];
    expect(heuristicLane(big, undefined, v1Cfg)).toBeNull();
  });
});

// ---- integration: skip-too-large, privacy-before-fit, no-fit-anywhere ----

function integrationCfg(): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    privacy: { block_patterns: ['AKIA[0-9A-Z]{16}'] },
    providers: {
      openrouter: {
        kind: 'openai',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        trains_on_data: true,
        limits: { rpm: 100, rpd: 5000 },
        model_limits: {
          'big-training:free': { rpm: 100, rpd: 5000, ctx: 1_000_000 },
        },
      },
      nvidia: {
        kind: 'openai',
        base_url: 'https://integrate.api.nvidia.com/v1',
        key_env: 'NVIDIA_API_KEY',
        trains_on_data: false,
        limits: { rpm: 100, rpd: 5000 },
        model_limits: {
          'tiny-model': { rpm: 100, rpd: 5000, ctx: 500 },
          'clean-model': { rpm: 100, rpd: 5000, ctx: 200_000 },
        },
      },
    },
    lanes: {
      FAST: ['nvidia/tiny-model'],
      SIMPLE: ['nvidia/tiny-model'],
      AGENTIC: ['openrouter/big-training:free', 'nvidia/clean-model'],
      HARD: ['nvidia/tiny-model'],
    },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(integrationCfg()));
});

describe('M6 integration', () => {
  it('a request too large for the small entry never dials it — only the model that fits is called', async () => {
    // Deterministic single-entry AGENTIC so escalation lands on exactly one
    // interceptable call — isolates the fit-filter behavior from privacy skip
    // (covered separately below).
    const cfg = integrationCfg();
    cfg.lanes.AGENTIC = ['nvidia/clean-model'];
    await env.CONFIG.put('config', JSON.stringify(cfg));
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }],
      });
    // tiny-model has ctx=500; this request estimates well over that, so FAST and
    // SIMPLE (both ['nvidia/tiny-model']) are entirely fit-filtered out — proven
    // by there being no second nvidia interceptor registered, so a stray call to
    // tiny-model would throw. Escalation climbs to AGENTIC, where clean-model fits.
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-lane': 'FAST' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'x'.repeat(5000) }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text: string }> };
    expect(json.content[0]!.text).toBe('served');
  });

  it('privacy guard still wins over fit: a smaller non-training model is preferred over a bigger training one', async () => {
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [
          { message: { role: 'assistant', content: 'safe answer' }, finish_reason: 'stop' },
        ],
      });
    // Both entries fit (big-training has 1M ctx, clean-model has 200k ctx) — the
    // fit filter must not reorder them by size; the privacy skip inside the loop
    // is what keeps openrouter/big-training:free from ever being dialed.
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-lane': 'AGENTIC' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'why does AKIAIOSFODNN7EXAMPLE not work?' }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('a request fitting nothing in any lane returns the synthetic notice naming the largest window', async () => {
    // Every lane in this config only has tiny-model (ctx=500) except AGENTIC,
    // which also can't hold this request — override AGENTIC too.
    const cfg = integrationCfg();
    cfg.lanes.AGENTIC = ['nvidia/tiny-model'];
    await env.CONFIG.put('config', JSON.stringify(cfg));
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-lane': 'FAST' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text: string }> };
    expect(json.content[0]!.text).toBe(noFitNoticeText(500));
    expect(json.content[0]!.text).toContain('500');
  });
});
