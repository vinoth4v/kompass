// CORS + provenance headers (2026-07-24): a hosted client on a different
// origin (the Vercel chat app) needs preflight to succeed, CORS headers on
// every response including errors, and x-kompass-served-by/x-kompass-lane so
// it can show which model actually answered.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RouterConfig } from '../src/worker/config';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function testConfig(): RouterConfig {
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
    lanes: { AGENTIC: ['openrouter/model-a:free'] },
  };
}

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-bearer-token',
};

function msgBody() {
  return JSON.stringify({
    model: 'kompass-agentic',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'ping' }],
  });
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(testConfig()));
});

describe('CORS', () => {
  it('answers an OPTIONS preflight without auth', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://kompass-chat.vercel.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('carries CORS headers on a 401 (bad bearer), not just on success', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://kompass-chat.vercel.app' },
      body: msgBody(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('a successful response carries served-by/lane headers, exposed for cross-origin JS', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, origin: 'https://kompass-chat.vercel.app' },
      body: msgBody(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kompass-served-by')).toBe('openrouter/model-a:free');
    expect(res.headers.get('x-kompass-lane')).toBe('AGENTIC');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-kompass-served-by');
  });
});
