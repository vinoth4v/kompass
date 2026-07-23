import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('worker ingress', () => {
  it('/healthz is open', async () => {
    const res = await SELF.fetch('https://kompass.test/healthz');
    expect(res.status).toBe(200);
  });

  it('rejects /v1/messages without bearer (401)', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts x-api-key as the bearer and proxies a non-streaming request', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, {
        id: 'gen-1',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-bearer-token' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.type).toBe('message');
    expect(json.content[0]).toEqual({ type: 'text', text: 'pong' });
    expect(json.model).toBe('claude-sonnet-4-5');
  });

  it('falls back to the second model when the first 429s', async () => {
    const origin = fetchMock.get('https://openrouter.ai');
    origin
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(429, { error: 'rate limited' });
    origin.intercept({ path: '/api/v1/chat/completions', method: 'POST' }).reply(200, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-bearer-token',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('estimates count_tokens', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-bearer-token',
      },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello world' }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.input_tokens).toBeGreaterThan(0);
  });
});
