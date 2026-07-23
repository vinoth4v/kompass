// M2 acceptance: DO quota ledger, exhaustion pre-skip, fallback, cooldown, stickiness.
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
        limits: { rpm: 20, rpd: 50 },
      },
      nvidia: {
        kind: 'openai',
        base_url: 'https://integrate.api.nvidia.com/v1',
        key_env: 'NVIDIA_API_KEY',
        limits: { rpm: 40, rpd: 5000 },
      },
    },
    lanes: {
      AGENTIC: ['openrouter/model-a:free', 'nvidia/model-b'],
    },
  };
}

function msgBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'ping' }],
    ...extra,
  });
}

const OK_OPENAI = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

function openaiSSE(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
  );
}

function openaiSSEWithUsage(text: string, tin: number, tout: number): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: tin, completion_tokens: tout },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
  // fresh DO state per test: unique session-independent reset via burn to zero is not
  // enough (cooldowns/sticky persist) — use a distinct DO instance per test file run
  // is impossible with idFromName('global'), so tests below are written to tolerate
  // ordering: they either reset counters via /ledger/burn or use fresh entries.
});

describe('M2 Durable Object ledger', () => {
  it('routes to provider B with zero 429s once provider A daily budget is exhausted', async () => {
    // "machine A" burns the whole openrouter daily budget…
    const burn = await SELF.fetch('https://kompass.test/ledger/burn', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ provider: 'openrouter', n: 50 }),
    });
    expect(burn.status).toBe(200);

    // …so "machine B"'s very first request must go straight to nvidia:
    // only the nvidia interceptor exists — touching openrouter would throw.
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, OK_OPENAI);
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    expect(res.status).toBe(200);

    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    expect(status.providers.openrouter.rpd.used).toBeGreaterThanOrEqual(50);
    expect(status.routes[0]).toMatchObject({ entry: 'nvidia/model-b', ok: true });

    // restore the budget for subsequent tests
    await SELF.fetch('https://kompass.test/ledger/burn', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ provider: 'openrouter', n: -50 }),
    });
  });

  it('failure cooldown: after A 429s, the next request skips A; success sticks the session to B', async () => {
    const origin = fetchMock.get('https://openrouter.ai');
    origin
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(429, { error: 'rate limited' });
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, OK_OPENAI);

    const session = { user_id: 'user_x_session_cooldown-test' };
    const r1 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ metadata: session }),
    });
    expect(r1.status).toBe(200); // fell back to nvidia; hop logged

    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    expect(Object.keys(status.cooldowns)).toContain('openrouter/model-a:free');
    const failed = status.routes.find((r: any) => r.entry === 'openrouter/model-a:free');
    expect(failed).toMatchObject({ ok: false });

    // Second request: A is cooling down AND B is sticky → only nvidia is called.
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, OK_OPENAI);
    const r2 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ metadata: session }),
    });
    expect(r2.status).toBe(200);
  });

  it('primary dying before first byte mid-stream request → fallback completes the stream', async () => {
    // openrouter replies 200 but with an empty body (no SSE data at all)
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, '');
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, openaiSSE('rescued'), {
        headers: { 'content-type': 'text/event-stream' },
      });

    // fresh session, and clear openrouter cooldown state via a distinct entry name is
    // not possible here — instead release any cooldown by using burn-reset semantics:
    // (cooldown for model-a may exist from the previous test; that's fine — the
    // outcome is identical: nvidia serves the stream.)
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('message_start');
    expect(text).toContain('rescued');
    expect(text).toContain('message_stop');
  }, 15_000);

  it('a 200 stream with no content (role-only then DONE) falls through to the next model', async () => {
    // the dataforge-local bug: provider streams "success" with zero content and the
    // client receives a finished-looking empty turn → session silently stops.
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(
        200,
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n` +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, openaiSSE('rescued-from-empty'), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('rescued-from-empty');
    expect(text).toContain('message_stop');
  }, 15_000);

  it('records token usage per route and per-provider daily totals', async () => {
    // non-stream: usage lands with the outcome report
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 45 },
      });
    await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    // stream: usage attaches at stream end
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, openaiSSEWithUsage('streamed', 200, 80), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const sres = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ stream: true }),
    });
    await sres.text(); // drain the stream so onFinal fires

    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    const nonStream = status.routes.find((r: any) => r.tin === 120);
    expect(nonStream).toMatchObject({ tin: 120, tout: 45, ok: true });
    const streamed = status.routes.find((r: any) => r.tin === 200);
    expect(streamed).toMatchObject({ tin: 200, tout: 80, ok: true });
    expect(status.providers.openrouter.tokens_today).toEqual({ in: 320, out: 125 });
  });

  it('sticky release endpoint works', async () => {
    const res = await SELF.fetch('https://kompass.test/session/release', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ session_id: 'user_x_session_cooldown-test' }),
    });
    expect(res.status).toBe(200);
  });
});
