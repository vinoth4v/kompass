// M3 acceptance: heuristic short-circuit, classifier verdict, cache, 429 fallback.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { estimateTokens, heuristicLane } from '../src/worker/dispatcher';
import type { AnthropicRequest } from '../src/adapters/types';
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
    dispatcher: {
      model: 'google/classifier-model',
      timeout_ms: 1500,
      cache_ttl_s: 300,
      confidence_floor: 0.6,
    },
    providers: {
      openrouter: {
        kind: 'openai',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        limits: { rpm: 100, rpd: 5000 },
      },
      google: {
        kind: 'gemini',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        key_env: 'GOOGLE_AI_KEY',
        limits: { rpm: 100, rpd: 5000 },
      },
    },
    lanes: {
      FAST: ['openrouter/fast-model:free'],
      SIMPLE: ['openrouter/simple-model:free'],
      AGENTIC: ['openrouter/agentic-model:free'],
      HARD: ['openrouter/hard-model:free'],
      LONGCTX: ['openrouter/longctx-model:free'],
    },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

const TOOLS = [
  { name: 'bash', description: 'run a command', input_schema: { type: 'object' } },
  { name: 'edit', description: 'edit a file', input_schema: { type: 'object' } },
];

function okFor(model: string) {
  fetchMock
    .get('https://openrouter.ai')
    .intercept({
      path: '/api/v1/chat/completions',
      method: 'POST',
      body: (b) => (JSON.parse(b as string) as { model: string }).model === model,
    })
    .reply(200, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
}

function classifierReplies(lane: string, confidence: number, times = 1) {
  fetchMock
    .get('https://generativelanguage.googleapis.com')
    .intercept({ path: '/v1beta/models/classifier-model:generateContent', method: 'POST' })
    .reply(200, {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: JSON.stringify({ lane, confidence }) }] },
          finishReason: 'STOP',
        },
      ],
    })
    .times(times);
}

describe('heuristics (unit)', () => {
  const base: AnthropicRequest = {
    model: 'm',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'rename this variable' }],
  };
  it('small tool-less request → FAST', () => {
    expect(heuristicLane(base)).toBe('FAST');
  });
  it('huge context → LONGCTX', () => {
    const big = { ...base, messages: [{ role: 'user' as const, content: 'x'.repeat(300_000) }] };
    expect(estimateTokens(big)).toBeGreaterThan(60_000);
    expect(heuristicLane(big)).toBe('LONGCTX');
  });
  it('tools present → no short-circuit (classifier decides)', () => {
    expect(heuristicLane({ ...base, tools: TOOLS })).toBeNull();
  });
});

describe('M3 dispatcher (integration)', () => {
  it('heuristic FAST short-circuit routes without any classifier call', async () => {
    okFor('fast-model:free');
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'what does chmod 755 mean?' }],
      }),
    });
    expect(res.status).toBe(200); // no classifier interceptor → any classifier call would fail
  });

  it('classifier verdict routes the SIMPLE lane; identical request hits the 5-min cache', async () => {
    classifierReplies('SIMPLE', 0.92, 1); // exactly ONE classifier call allowed
    okFor('simple-model:free');
    okFor('simple-model:free');
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      tools: TOOLS,
      messages: [{ role: 'user', content: 'add a docstring to parse_config in utils.py' }],
    });
    const r1 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body,
    });
    expect(r1.status).toBe(200);
    // second identical request: cache hit — classifier interceptor is exhausted,
    // so a second call would throw NoPendingInterceptors inside the worker.
    const r2 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body,
    });
    expect(r2.status).toBe(200);
  });

  it('low-confidence verdict falls back to AGENTIC', async () => {
    classifierReplies('HARD', 0.3);
    okFor('agentic-model:free');
    const res = await SELF.fetch('https://kompass.test/dispatch/preview', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'low confidence task variant A' }],
      }),
    });
    const verdict = (await res.json()) as any;
    expect(verdict.lane).toBe('AGENTIC');
    expect(verdict.source).toBe('classifier');
    // consume the unused lane interceptor so assertNoPendingInterceptors passes
    await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-model': 'openrouter/agentic-model:free' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi there friend'.repeat(80) }],
        tools: TOOLS,
      }),
    });
  });

  it('classifier 429 → request still routes (heuristics-only fallback, never block)', async () => {
    fetchMock
      .get('https://generativelanguage.googleapis.com')
      .intercept({ path: '/v1beta/models/classifier-model:generateContent', method: 'POST' })
      .reply(429, { error: { message: 'rate limited' } });
    okFor('agentic-model:free');
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'refactor the auth module across files' }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it('malformed classifier JSON → AGENTIC fallback, request still routes', async () => {
    fetchMock
      .get('https://generativelanguage.googleapis.com')
      .intercept({ path: '/v1beta/models/classifier-model:generateContent', method: 'POST' })
      .reply(200, {
        candidates: [{ content: { role: 'model', parts: [{ text: 'certainly! the lane is…' }] } }],
      });
    okFor('agentic-model:free');
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        tools: TOOLS,
        messages: [{ role: 'user', content: 'fix the flaky websocket reconnect test' }],
      }),
    });
    expect(res.status).toBe(200);
  });
});
