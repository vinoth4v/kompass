import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RouterConfig } from '../src/worker/config';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function testConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
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
      google: {
        kind: 'gemini',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        key_env: 'GOOGLE_AI_KEY',
        limits: { rpm: 10, rpd: 500 },
      },
      groq: {
        kind: 'openai',
        base_url: 'https://api.groq.com/openai/v1',
        key_env: 'GROQ_API_KEY',
        enabled: false,
        limits: { rpm: 30, rpd: 1000 },
      },
    },
    // no FAST lane on purpose: small tool-less test bodies would heuristically
    // land there (M3); without it they fall back to the default lane.
    lanes: {
      AGENTIC: ['openrouter/model-a:free', 'openrouter/model-b:free'],
    },
    ...overrides,
  };
}

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-bearer-token',
};

function msgBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'ping' }],
    ...extra,
  });
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(testConfig()));
});

describe('worker ingress', () => {
  it('/healthz is open', async () => {
    const res = await SELF.fetch('https://kompass.test/healthz');
    expect(res.status).toBe(200);
  });

  it('rejects /v1/messages without bearer (401)', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: msgBody(),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when no config is in KV', async () => {
    await env.CONFIG.delete('config');
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(res.status).toBe(503);
  });

  it('routes the default lane to the first chain entry (OpenAI adapter)', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: (b) => JSON.parse(b as string).model === 'model-a:free',
      })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.content[0]).toEqual({ type: 'text', text: 'pong' });
  });

  it('falls back to the next chain entry when the first 429s', async () => {
    const origin = fetchMock.get('https://openrouter.ai');
    origin
      .intercept({
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: (b) => JSON.parse(b as string).model === 'model-a:free',
      })
      .reply(429, { error: 'rate limited' });
    origin
      .intercept({
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: (b) => JSON.parse(b as string).model === 'model-b:free',
      })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(res.status).toBe(200);
  });

  it('routes to the Gemini adapter via the x-kompass-model override', async () => {
    fetchMock
      .get('https://generativelanguage.googleapis.com')
      .intercept({
        path: '/v1beta/models/gemini-test-flash:generateContent',
        method: 'POST',
      })
      .reply(200, {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'gemini pong' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-model': 'google/gemini-test-flash' },
      body: msgBody(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.content[0]).toEqual({ type: 'text', text: 'gemini pong' });
    expect(json.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
  });

  it('hot-reload: POST /config changes the active chain with no redeploy', async () => {
    // before: chain hits model-a
    fetchMock
      .get('https://openrouter.ai')
      .intercept({
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: (b) => JSON.parse(b as string).model === 'model-a:free',
      })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'from-a' }, finish_reason: 'stop' }],
      });
    let res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(((await res.json()) as any).content[0].text).toBe('from-a');

    // push a new config whose AGENTIC chain starts with model-c
    const newCfg = testConfig({
      lanes: { AGENTIC: ['openrouter/model-c:free'] },
    });
    const push = await SELF.fetch('https://kompass.test/config', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(newCfg),
    });
    expect(push.status).toBe(200);

    // after: chain hits model-c without any redeploy
    fetchMock
      .get('https://openrouter.ai')
      .intercept({
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: (b) => JSON.parse(b as string).model === 'model-c:free',
      })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'from-c' }, finish_reason: 'stop' }],
      });
    res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(((await res.json()) as any).content[0].text).toBe('from-c');
  });

  it('rejects a config with a paid (non-:free) OpenRouter model when allow_paid=false', async () => {
    const bad = testConfig({
      lanes: { AGENTIC: ['openrouter/some-paid-model'] },
    });
    const res = await SELF.fetch('https://kompass.test/config', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('allow_paid');
  });

  it('skips disabled providers without failing the request', async () => {
    await env.CONFIG.put(
      'config',
      JSON.stringify(
        testConfig({
          lanes: {
            AGENTIC: ['groq/llama-test', 'openrouter/model-a:free'],
          },
        }),
      ),
    );
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(res.status).toBe(200);
  });

  it('estimates count_tokens', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/messages/count_tokens', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello world' }] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).input_tokens).toBeGreaterThan(0);
  });
});
