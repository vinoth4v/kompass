// 2026-07-25 regression: Cloudflare error 1102 ("Worker exceeded resource
// limits") killing live Claude Code sessions. Two independent causes, one test
// file:
//   1. Every chain attempt re-ran the full Anthropic→provider translation of a
//      multi-MB body. payload.ts now does the deep translation once per request.
//   2. A single request could walk the entire roster (initial lane → escalation
//      hops → last-resort sweep). There is now one shared attempt budget for
//      the whole request, and exhausting it degrades to the normal friendly
//      notice — never a fatal status the client can't recover from.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RouterConfig } from '../src/worker/config';
import type { AnthropicRequest } from '../src/adapters/types';
import { geminiBody, geminiPayload, openAIBody, openAIPayload } from '../src/worker/payload';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-bearer-token',
};

/** 12 entries in one lane — more than the 8-attempt ceiling, all on one host. */
const ENTRY_COUNT = 12;
const MAX_UPSTREAM_ATTEMPTS = 8;

function cfg(): RouterConfig {
  const model_limits: Record<string, { rpm: number; rpd: number; ctx: number }> = {};
  for (let i = 0; i < ENTRY_COUNT; i++) {
    model_limits[`m${i}`] = { rpm: 100, rpd: 1000, ctx: 1_000_000 };
  }
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      rl: {
        kind: 'openai',
        base_url: 'https://rl.test/v1',
        key_env: 'OPENROUTER_API_KEY',
        limits: { rpm: 100, rpd: 1000 },
        model_limits,
      },
    },
    lanes: {
      AGENTIC: Array.from({ length: ENTRY_COUNT }, (_, i) => `rl/m${i}`),
    },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('per-request upstream attempt budget (error 1102)', () => {
  it('stops at the ceiling and still answers with a recoverable turn', async () => {
    // EXACTLY the budget's worth of interceptors. A 9th attempt finds no
    // matching interceptor and throws; fewer than 8 leaves one pending and
    // afterEach's assertNoPendingInterceptors fails. So this pins the count.
    fetchMock
      .get('https://rl.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(500, { error: 'upstream down' })
      .times(MAX_UPSTREAM_ATTEMPTS);

    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        // A tool forces the classifier/fallback path rather than the FAST
        // heuristic, so this routes into the 12-entry AGENTIC chain.
        tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'refactor the auth middleware' }],
      }),
    });

    // The whole point: a normal 200 the session survives, not a fatal error.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toContain('Free lanes are exhausted');
  });
});

describe('per-request payload cache (error 1102)', () => {
  const body: AnthropicRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  };

  it('reuses the deep translation across attempts, varying only shallow fields', () => {
    const a = openAIPayload(body, 'model-a', false);
    const b = openAIPayload(body, 'model-b', true);

    // The expensive parts are shared BY REFERENCE — not re-derived per attempt.
    expect(a.messages).toBe(b.messages);
    expect(a.tools).toBe(b.tools);
    // …while the per-attempt fields still differ.
    expect(a.model).toBe('model-a');
    expect(b.model).toBe('model-b');
    expect(a.stream).toBe(false);
    expect(b.stream).toBe(true);
    // Mutating one attempt's payload must not leak into the next.
    expect(a).not.toBe(b);
  });

  it('never carries stream_options (some free providers reject it)', () => {
    expect(openAIPayload(body, 'model-a', true).stream_options).toBeUndefined();
  });

  it('openAIBody splices model/stream into a cached tail, equivalent to a full stringify', () => {
    // The point of the tail cache is skipping JSON.stringify per attempt. If the
    // splice ever diverges from the real serialization, providers get a
    // malformed body — so compare against the uncached path. Compared PARSED,
    // not byte-for-byte: the splice puts model/stream first, and JSON key order
    // carries no meaning (nor does any provider depend on it).
    for (const [model, stream] of [
      ['model-a', false],
      ['model-b', true],
    ] as const) {
      const spliced = openAIBody(body, model, stream);
      expect(JSON.parse(spliced)).toEqual(openAIPayload(body, model, stream));
      const parsed = JSON.parse(spliced) as Record<string, unknown>;
      expect(parsed.model).toBe(model);
      expect(parsed.stream).toBe(stream);
    }
    // Deterministic across attempts, and the gemini body needs no splicing.
    expect(openAIBody(body, 'x', false)).toBe(openAIBody(body, 'x', false));
    expect(JSON.parse(geminiBody(body))).toEqual(geminiPayload(body));
  });

  it('caches per request object, not globally', () => {
    const other: AnthropicRequest = {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'different request' }],
    };
    expect(openAIPayload(body, 'm', false).messages).not.toBe(
      openAIPayload(other, 'm', false).messages,
    );
    expect(geminiPayload(body)).toBe(geminiPayload(body));
    expect(geminiPayload(body)).not.toBe(geminiPayload(other));
  });
});

/**
 * Cooldown handling when a burst has cooled the ENTIRE roster (2026-07-25).
 * A cooldown is a health heuristic, not a hard limit, so a fully-cold chain
 * must still try its most-likely-recovered entry rather than emit the
 * exhaustion notice with zero provider calls — and there is a manual reset
 * for the same state.
 */
describe('all-models-cooling recovery', () => {
  /** Fail every entry once, which puts a 10-minute cooldown on each. */
  async function coolEverything() {
    fetchMock
      .get('https://rl.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(500, { error: 'upstream down' })
      .times(MAX_UPSTREAM_ATTEMPTS);
    await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'first request, fails everywhere' }],
      }),
    });
  }

  const followUp = () =>
    SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'second request, everything is cooling' }],
      }),
    });

  it('still tries one cold model instead of giving up with zero provider calls', async () => {
    await coolEverything();

    // Exactly one interceptor: the rescue must call a provider, and only one.
    fetchMock
      .get('https://rl.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

    const res = await followUp();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toBe('recovered');
  });

  it('POST /ledger/clear-cooldowns drops them all and routing resumes', async () => {
    await coolEverything();

    const cleared = await SELF.fetch('https://kompass.test/ledger/clear-cooldowns', {
      method: 'POST',
      headers: AUTH,
    });
    expect(cleared.status).toBe(200);
    // 8, not ENTRY_COUNT: the attempt budget stopped the first request after 8
    // upstream calls, so only those 8 entries ever failed and got cooled — a
    // second confirmation that the ceiling is doing its job.
    expect((await cleared.json()) as { cleared: number }).toEqual({
      cleared: MAX_UPSTREAM_ATTEMPTS,
    });

    const status = await SELF.fetch('https://kompass.test/status', { headers: AUTH });
    expect(Object.keys(((await status.json()) as { cooldowns: object }).cooldowns)).toHaveLength(0);

    // With cooldowns gone the chain is fully available again — the request now
    // resolves on the FIRST entry, not via the single-entry rescue path.
    fetchMock
      .get('https://rl.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'healthy' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

    const res = await followUp();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toBe('healthy');
  });
});
