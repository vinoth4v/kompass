// Daily usage aggregates (2026-07-24): every routed outcome lands in a per-day
// history cell that /status exposes for the dashboard's analytics tab.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

function cfg(): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      openrouter: {
        kind: 'openai',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        limits: { rpm: 100, rpd: 5000 },
      },
    },
    lanes: { AGENTIC: ['openrouter/model-a:free'] },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('daily history aggregates', () => {
  it('a routed request lands in /status history for today', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
    const routed = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'kompass-agentic',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(routed.status).toBe(200);

    const res = await SELF.fetch('https://kompass.test/status', { headers: AUTH });
    expect(res.status).toBe(200);
    const status = (await res.json()) as {
      history: Record<
        string,
        {
          providers: Record<string, { req: number; ok: number; tin: number; tout: number }>;
          models: Record<string, { req: number; ok: number }>;
          lanes: Record<string, number>;
        }
      >;
    };
    const today = new Date().toISOString().slice(0, 10);
    const day = status.history[today];
    expect(day).toBeDefined();
    expect(day!.providers.openrouter).toMatchObject({ req: 1, ok: 1, tin: 11, tout: 7 });
    expect(day!.models['openrouter/model-a:free']).toMatchObject({ req: 1, ok: 1 });
    expect(day!.lanes.AGENTIC).toBe(1);
  });
});
