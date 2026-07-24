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

function okReply(text: string, usage?: { tin: number; tout: number }) {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    ...(usage ? { usage: { prompt_tokens: usage.tin, completion_tokens: usage.tout } } : {}),
  };
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

  it('primary erroring outright on a streamed request → fallback completes it (client never sees an error)', async () => {
    // Kompass always calls upstream non-streaming and buffers the full answer
    // before ever writing to the client — so a provider dying HOWEVER (garbled
    // body, error, timeout) is invisible to Claude Code; it just takes longer.
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, 'not valid json'); // upstream.json() throws → falls through
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, okReply('rescued'));

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
    expect(text).not.toContain('event: error'); // never a client-visible failure
  });

  it('a 200 response with zero content blocks (empty completion) falls through to the next model', async () => {
    // the dataforge-local bug: provider returns "success" with nothing to say and
    // Claude Code takes it as a finished empty turn → session silently stops.
    // Kompass now treats an empty translated response as a failure, same as any
    // other bad response, and falls through — the client never sees it.
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      });
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, okReply('rescued-from-empty'));
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('rescued-from-empty');
    expect(text).toContain('message_stop');

    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    const failed = status.routes.find((r: any) => r.entry === 'openrouter/model-a:free' && !r.ok);
    expect(failed?.detail).toMatch(/empty/i);
  });

  it('records token usage per route and per-provider daily totals (non-stream and streamed requests alike)', async () => {
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, okReply('hi', { tin: 120, tout: 45 }));
    await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody(),
    });
    fetchMock
      .get('https://openrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(200, okReply('streamed', { tin: 200, tout: 80 }));
    const sres = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: msgBody({ stream: true }),
    });
    await sres.text();

    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    const nonStream = status.routes.find((r: any) => r.tin === 120);
    expect(nonStream).toMatchObject({ tin: 120, tout: 45, ok: true });
    const streamed = status.routes.find((r: any) => r.tin === 200);
    expect(streamed).toMatchObject({ tin: 200, tout: 80, ok: true });
    expect(status.providers.openrouter.tokens_today).toEqual({ in: 320, out: 125 });
  });

  it('spread_top:1 (default) always tries chain[0] first — no behavior change', async () => {
    // fetchMock (undici's MockAgent) is shared across every test in this file, not
    // reset per `it()` — a `.persist()` interceptor with no body filter would keep
    // matching in later tests too. One-shot interceptors registered exactly as many
    // times as consumed avoid that leakage.
    for (let i = 0; i < 5; i++) {
      fetchMock
        .get('https://openrouter.ai')
        .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
        .reply(200, OK_OPENAI);
      const res = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: AUTH,
        body: msgBody(),
      });
      expect(res.status).toBe(200);
    }
    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    // every one of the 5 trials landed on chain[0] — never spread by default
    expect(status.routes.slice(0, 5).every((r: any) => r.entry === 'openrouter/model-a:free')).toBe(
      true,
    );
  });

  it('spread_top:2 weighted-picks a proven performer over a listed-first poor performer', async () => {
    // M8: spread-selection weighting reads score:<lane>:<entry>, not perf:<entry>
    // (perf:* stays as a separate, display-only counter since M8) — seed the
    // adaptive score cells directly, mirroring the old seed-perf helper.
    await SELF.fetch('https://kompass.test/ledger/seed-score', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        lane: 'AGENTIC',
        entry: 'openrouter/spread-bad:free',
        health: 0.05,
        penalties: 0,
        attempts: 20,
      }),
    });
    await SELF.fetch('https://kompass.test/ledger/seed-score', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        lane: 'AGENTIC',
        entry: 'openrouter/spread-good:free',
        health: 1,
        penalties: 0,
        attempts: 20,
      }),
    });
    const spreadCfg = cfg();
    // 30 trials would blow the default 20 RPM ceiling mid-loop (both entries share
    // the provider-level counter here) — raise it so RPM isn't the bottleneck.
    spreadCfg.providers.openrouter!.limits = { rpm: 1000, rpd: 5000 };
    spreadCfg.lanes.AGENTIC = {
      // bad is listed FIRST (highest static priority) — pure priority order would
      // always pick it; the weighted pick should favor good instead, most of the time.
      chain: ['openrouter/spread-bad:free', 'openrouter/spread-good:free'],
      spread_top: 2,
    };
    await env.CONFIG.put('config', JSON.stringify(spreadCfg));

    let goodCount = 0;
    const trials = 30;
    for (let i = 0; i < trials; i++) {
      // One-shot interceptor per trial (no persist — see note above); the reply
      // callback inspects the actual request body so a single registration covers
      // whichever of the two models the weighted pick sends.
      fetchMock
        .get('https://openrouter.ai')
        .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
        .reply(200, (opts) => {
          const model = (JSON.parse(opts.body as string) as { model: string }).model;
          const content = model === 'spread-good:free' ? 'GOOD' : 'BAD';
          return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
        });
      const res = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: AUTH,
        body: msgBody(),
      });
      const json = (await res.json()) as any;
      if (json.content[0].text === 'GOOD') goodCount++;
    }
    // Not deterministic (weighted random), but with weights ~1.0 vs floor 0.05 the
    // skew should be overwhelming — a generous threshold keeps this test stable.
    expect(goodCount).toBeGreaterThan(trials * 0.7);
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
