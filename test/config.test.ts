import { describe, expect, it } from 'vitest';
import {
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
