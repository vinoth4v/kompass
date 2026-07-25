// 2026-07-25 regressions: (1) a lane outside the FAST→SIMPLE→AGENTIC→HARD
// escalation ladder — i.e. LONGCTX — must not end the turn the moment its own
// chain is spent; (2) the ledger must account for tokens-per-minute, not just
// request counts, or a handful of huge requests blows a provider's TPM ceiling
// while the RPM/RPD counters still show headroom.
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

const OK_OPENAI = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

/**
 * AGENTIC's smallest ctx (4000) is what the dispatcher derives its LONGCTX
 * threshold from, so a request over ~4000 estimated tokens routes to LONGCTX
 * without needing the classifier. The rescue entry lives in SIMPLE — a lane the
 * escalation ladder would never reach from LONGCTX.
 */
function cfg(): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      lr_long: {
        kind: 'openai',
        base_url: 'https://lr-long.test/v1',
        key_env: 'OPENROUTER_API_KEY',
        limits: { rpm: 20, rpd: 500 },
        model_limits: { 'longctx-a': { rpm: 20, rpd: 500, ctx: 1_000_000 } },
      },
      lr_rescue: {
        kind: 'openai',
        base_url: 'https://lr-rescue.test/v1',
        key_env: 'NVIDIA_API_KEY',
        limits: { rpm: 20, rpd: 500 },
        model_limits: { 'rescue-big': { rpm: 20, rpd: 500, ctx: 1_000_000 } },
      },
      lr_small: {
        kind: 'openai',
        base_url: 'https://lr-small.test/v1',
        key_env: 'NVIDIA_API_KEY',
        limits: { rpm: 20, rpd: 500 },
        model_limits: { 'agentic-small': { rpm: 20, rpd: 500, ctx: 4_000 } },
      },
    },
    lanes: {
      AGENTIC: ['lr_small/agentic-small'],
      SIMPLE: ['lr_rescue/rescue-big'],
      LONGCTX: ['lr_long/longctx-a'],
    },
  };
}

/** ~30k chars → ~7.5k estimated tokens: over AGENTIC's 4000 ctx, so LONGCTX. */
function bigBody() {
  return JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'x'.repeat(30_000) }],
  });
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('last-resort pass (lanes with no lane above them)', () => {
  it('LONGCTX chain exhausted → sweeps other lanes instead of emitting the exhaustion notice', async () => {
    // The only LONGCTX entry fails outright…
    fetchMock
      .get('https://lr-long.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(500, { error: 'upstream down' });
    // …and the rescue lives in SIMPLE, which no escalation from LONGCTX reaches.
    fetchMock
      .get('https://lr-rescue.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, OK_OPENAI);
    // lr_small is deliberately NOT intercepted: its 4000-token ctx cannot hold
    // this request, so the fit filter must drop it before dispatch. If the
    // last-resort pass ignored fit, this test would throw on an un-mocked call.

    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: bigBody(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-kompass-served-by')).toBe('lr_rescue/rescue-big');
    const body = (await res.json()) as any;
    expect(body.content[0].text).toBe('ok');
    expect(body.content[0].text).not.toContain('Free lanes are exhausted');
  });

  it('still emits the exhaustion notice when every entry everywhere fails', async () => {
    fetchMock
      .get('https://lr-long.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(500, { error: 'upstream down' });
    fetchMock
      .get('https://lr-rescue.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(500, { error: 'upstream down' });

    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: bigBody(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.content[0].text).toContain('Free lanes are exhausted');
  });
});

function tpmCfg(): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      tpm_tight: {
        kind: 'openai',
        base_url: 'https://tpm-tight.test/v1',
        key_env: 'OPENROUTER_API_KEY',
        // Generous request counts, tight token budget — exactly the Gemini
        // free-tier shape that produced the original 429s.
        limits: { rpm: 50, rpd: 500, tpm: 10_000, ctx: 1_000_000 },
      },
      tpm_spare: {
        kind: 'openai',
        base_url: 'https://tpm-spare.test/v1',
        key_env: 'NVIDIA_API_KEY',
        limits: { rpm: 50, rpd: 500, ctx: 1_000_000 },
      },
    },
    lanes: {
      AGENTIC: ['tpm_tight/tight-1', 'tpm_spare/spare-1'],
    },
  };
}

describe('ledger TPM accounting', () => {
  it('a second huge request in the same minute is skipped on tpm, not sent upstream', async () => {
    await env.CONFIG.put('config', JSON.stringify(tpmCfg()));

    // ~30k chars ≈ 8.3k estimated tokens against a 10k/minute ceiling: the
    // first request fits, the second cannot.
    const body = () =>
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'y'.repeat(30_000) }],
      });

    fetchMock
      .get('https://tpm-tight.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, OK_OPENAI);
    const r1 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: body(),
    });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-kompass-served-by')).toBe('tpm_tight/tight-1');

    // Only the spare provider is intercepted now — if the TPM window were not
    // enforced, the router would call tpm_tight again and throw on a missing
    // interceptor rather than falling through.
    fetchMock
      .get('https://tpm-spare.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, OK_OPENAI);
    const r2 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: body(),
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-kompass-served-by')).toBe('tpm_spare/spare-1');
  });

  it('does not over-throttle: small requests keep using the tpm-limited lead', async () => {
    await env.CONFIG.put('config', JSON.stringify(tpmCfg()));
    const small = () =>
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object' } }],
      });

    // TPM charges estimated tokens, not a flat per-request cost — several small
    // requests in one minute must stay far under the 10k ceiling and keep
    // landing on the lead entry rather than being pushed down the chain.
    for (let i = 0; i < 3; i++) {
      fetchMock
        .get('https://tpm-tight.test')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, OK_OPENAI);
      const r = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: AUTH,
        body: small(),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('x-kompass-served-by')).toBe('tpm_tight/tight-1');
    }
  });
});
