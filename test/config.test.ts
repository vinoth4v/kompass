import { describe, expect, it } from 'vitest';
import {
  applyDeprecations,
  isModelDisabled,
  laneChainArray,
  laneSpreadTop,
  resolveLaneChain,
  resolveLaneSpreadTop,
  validateConfig,
  type RouterConfig,
} from '../src/worker/config';

function baseCfg(lanes: RouterConfig['lanes']): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      openrouter: {
        kind: 'openai',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        limits: { rpm: 20, rpd: 50 },
      },
    },
    lanes,
  };
}

describe('lane config helpers', () => {
  it('laneChainArray handles both bare-array and object forms', () => {
    expect(laneChainArray(['a/b'])).toEqual(['a/b']);
    expect(laneChainArray({ chain: ['a/b'], spread_top: 3 })).toEqual(['a/b']);
    expect(laneChainArray(undefined)).toEqual([]);
  });

  it('laneSpreadTop defaults to the fallback for bare arrays, reads object override', () => {
    expect(laneSpreadTop(['a/b'], 1)).toBe(1);
    expect(laneSpreadTop({ chain: ['a/b'], spread_top: 3 }, 1)).toBe(3);
    expect(laneSpreadTop({ chain: ['a/b'] }, 1)).toBe(1);
  });

  it('resolveLaneChain/resolveLaneSpreadTop fall back to default_lane', () => {
    const cfg = baseCfg({
      AGENTIC: { chain: ['openrouter/a:free', 'openrouter/b:free'], spread_top: 2 },
    });
    expect(resolveLaneChain(cfg, 'MISSING')).toEqual(['openrouter/a:free', 'openrouter/b:free']);
    expect(resolveLaneSpreadTop(cfg, 'MISSING')).toBe(2);
    expect(resolveLaneSpreadTop(cfg, 'AGENTIC')).toBe(2);
  });
});

describe('validateConfig with lane objects', () => {
  it('accepts {chain, spread_top} lanes', () => {
    const cfg = baseCfg({
      AGENTIC: { chain: ['openrouter/a:free'], spread_top: 2 },
    });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a non-positive-integer spread_top', () => {
    const cfg = baseCfg({
      AGENTIC: { chain: ['openrouter/a:free'], spread_top: 0 },
    });
    expect(() => validateConfig(cfg)).toThrow(/spread_top/);
  });

  it('still rejects an empty chain in object form', () => {
    const cfg = baseCfg({ AGENTIC: { chain: [] } });
    expect(() => validateConfig(cfg)).toThrow(/empty chain/);
  });

  it('still accepts the legacy bare-array form unchanged', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('deprecated_models validation', () => {
  it('rejects a replaced_by referencing an unknown provider', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    cfg.deprecated_models = { 'openrouter/old:free': { replaced_by: 'ghost/new:free' } };
    expect(() => validateConfig(cfg)).toThrow(/unknown provider/);
  });

  it('rejects a replaced_by that is a paid (non-:free) OpenRouter model when allow_paid=false', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    cfg.deprecated_models = { 'openrouter/old:free': { replaced_by: 'openrouter/new-paid' } };
    expect(() => validateConfig(cfg)).toThrow(/allow_paid/);
  });

  it('accepts a well-formed deprecation', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    cfg.deprecated_models = {
      'openrouter/old:free': {
        replaced_by: 'openrouter/a:free',
        note: 'superseded',
        since: '2026-07-23',
      },
    };
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('applyDeprecations', () => {
  it('rewrites every occurrence across lanes and the dispatcher', () => {
    const cfg = baseCfg({
      AGENTIC: ['openrouter/old:free', 'openrouter/keep:free'],
      SIMPLE: { chain: ['openrouter/old:free'], spread_top: 2 },
    });
    cfg.dispatcher = { model: 'openrouter/old:free', fallbacks: ['openrouter/keep:free'] };
    cfg.deprecated_models = { 'openrouter/old:free': { replaced_by: 'openrouter/new:free' } };

    const subs = applyDeprecations(cfg);

    expect(laneChainArray(cfg.lanes.AGENTIC)).toEqual([
      'openrouter/new:free',
      'openrouter/keep:free',
    ]);
    expect(laneChainArray(cfg.lanes.SIMPLE)).toEqual(['openrouter/new:free']);
    expect(cfg.dispatcher.model).toBe('openrouter/new:free');
    expect(cfg.dispatcher.fallbacks).toEqual(['openrouter/keep:free']);
    expect(subs).toEqual(['openrouter/old:free → openrouter/new:free']);
  });

  it('follows a chain of deprecations (a→b→c) and stops at a cycle instead of looping forever', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    cfg.deprecated_models = {
      'openrouter/a:free': { replaced_by: 'openrouter/b:free' },
      'openrouter/b:free': { replaced_by: 'openrouter/c:free' },
    };
    applyDeprecations(cfg);
    expect(laneChainArray(cfg.lanes.AGENTIC)).toEqual(['openrouter/c:free']);

    const cyclic = baseCfg({ AGENTIC: ['openrouter/x:free'] });
    cyclic.deprecated_models = {
      'openrouter/x:free': { replaced_by: 'openrouter/y:free' },
      'openrouter/y:free': { replaced_by: 'openrouter/x:free' },
    };
    expect(() => applyDeprecations(cyclic)).not.toThrow();
  });

  it('is a no-op when deprecated_models is absent or empty', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    expect(applyDeprecations(cfg)).toEqual([]);
    expect(laneChainArray(cfg.lanes.AGENTIC)).toEqual(['openrouter/a:free']);
  });
});

describe('disabled_models', () => {
  it('validates: entries must parse and reference a known provider', () => {
    const ok = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    ok.disabled_models = ['openrouter/a:free'];
    expect(() => validateConfig(ok)).not.toThrow();

    const badShape = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    badShape.disabled_models = ['not-a-chain-entry'];
    expect(() => validateConfig(badShape)).toThrow();

    const unknownProvider = baseCfg({ AGENTIC: ['openrouter/a:free'] });
    unknownProvider.disabled_models = ['ghost/model'];
    expect(() => validateConfig(unknownProvider)).toThrow(/unknown provider/);
  });

  it('isModelDisabled checks the switch list; absent list means nothing is disabled', () => {
    const cfg = baseCfg({ AGENTIC: ['openrouter/a:free', 'openrouter/b:free'] });
    expect(isModelDisabled(cfg, 'openrouter/a:free')).toBe(false);
    cfg.disabled_models = ['openrouter/a:free'];
    expect(isModelDisabled(cfg, 'openrouter/a:free')).toBe(true);
    expect(isModelDisabled(cfg, 'openrouter/b:free')).toBe(false);
  });
});
