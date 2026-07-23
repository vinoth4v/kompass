// Scheduled model-discovery: roster parsing per provider shape, configured-model
// diffing, and the /discovery + /discovery/run endpoints (detect-only, never
// mutates config).
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configuredModelsByProvider, parseModelList } from '../src/worker/discovery';
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

describe('parseModelList (unit)', () => {
  it('parses OpenAI-style {data:[{id}]} (default shape)', () => {
    expect(parseModelList('groq', 'openai', { data: [{ id: 'llama-3.1-8b-instant' }] })).toEqual([
      'llama-3.1-8b-instant',
    ]);
  });
  it('parses Gemini-style {models:[{name:"models/x"}]}, stripping the prefix', () => {
    expect(
      parseModelList('google', 'gemini', {
        models: [{ name: 'models/gemini-3.5-flash-lite' }, { name: 'models/gemini-3.6-flash' }],
      }),
    ).toEqual(['gemini-3.5-flash-lite', 'gemini-3.6-flash']);
  });
  it('parses GitHub catalog bare array', () => {
    expect(
      parseModelList('github', 'openai', [{ id: 'openai/gpt-4.1' }, { id: 'openai/gpt-5' }]),
    ).toEqual(['openai/gpt-4.1', 'openai/gpt-5']);
  });
  it('parses Cloudflare Workers AI {success,result:[{name}]}', () => {
    expect(
      parseModelList('cfai', 'openai', {
        success: true,
        result: [{ name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }],
      }),
    ).toEqual(['@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
  });
  it('returns [] for malformed/unexpected shapes rather than throwing', () => {
    expect(parseModelList('groq', 'openai', { unexpected: true })).toEqual([]);
    expect(parseModelList('groq', 'openai', null)).toEqual([]);
  });
});

describe('configuredModelsByProvider (unit)', () => {
  it('collects models referenced across lanes and the dispatcher (incl. fallbacks)', () => {
    const cfg: RouterConfig = {
      default_lane: 'AGENTIC',
      allow_paid: false,
      providers: {},
      lanes: {
        AGENTIC: ['openrouter/a:free', 'nvidia/b'],
        FAST: { chain: ['nvidia/c'], spread_top: 2 },
      },
      dispatcher: { model: 'google/d', fallbacks: ['groq/e'] },
    };
    const out = configuredModelsByProvider(cfg);
    expect(out.openrouter?.has('a:free')).toBe(true);
    expect(out.nvidia?.has('b')).toBe(true);
    expect(out.nvidia?.has('c')).toBe(true);
    expect(out.google?.has('d')).toBe(true);
    expect(out.groq?.has('e')).toBe(true);
  });
});

function cfg(): RouterConfig {
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
    lanes: { AGENTIC: ['openrouter/known-model:free'] },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('discovery endpoints (integration)', () => {
  it('GET /discovery 404s before any run has happened', async () => {
    const res = await SELF.fetch('https://kompass.test/discovery', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('POST /discovery/run fetches rosters, diffs vs configured, stores + returns a report', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/models', method: 'GET' })
      .reply(200, {
        data: [{ id: 'known-model:free' }, { id: 'brand-new-model:free' }],
      });
    const run = await SELF.fetch('https://kompass.test/discovery/run', {
      method: 'POST',
      headers: AUTH,
    });
    expect(run.status).toBe(200);
    const report = (await run.json()) as any;
    expect(report.providers.openrouter.liveCount).toBe(2);
    expect(report.providers.openrouter.unconfigured).toEqual(['brand-new-model:free']);
    expect(report.providers.openrouter.newSinceLast).toEqual([]); // no prior snapshot yet

    // now reachable via GET without re-running
    const get = await SELF.fetch('https://kompass.test/discovery', { headers: AUTH });
    expect(get.status).toBe(200);
    expect(((await get.json()) as any).providers.openrouter.unconfigured).toEqual([
      'brand-new-model:free',
    ]);
  });

  it('a second run flags models absent from the first snapshot as newSinceLast', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/models', method: 'GET' })
      .reply(200, { data: [{ id: 'known-model:free' }] });
    await SELF.fetch('https://kompass.test/discovery/run', { method: 'POST', headers: AUTH });

    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/models', method: 'GET' })
      .reply(200, { data: [{ id: 'known-model:free' }, { id: 'just-launched:free' }] });
    const run2 = await SELF.fetch('https://kompass.test/discovery/run', {
      method: 'POST',
      headers: AUTH,
    });
    const report = (await run2.json()) as any;
    expect(report.providers.openrouter.newSinceLast).toEqual(['just-launched:free']);
  });

  it('never mutates the pushed config — discovery is detect-only', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/models', method: 'GET' })
      .reply(200, { data: [{ id: 'known-model:free' }, { id: 'never-added:free' }] });
    await SELF.fetch('https://kompass.test/discovery/run', { method: 'POST', headers: AUTH });
    const config = (await (
      await SELF.fetch('https://kompass.test/config', { headers: AUTH })
    ).json()) as RouterConfig;
    expect(config.lanes.AGENTIC).toEqual(['openrouter/known-model:free']); // unchanged
  });
});
