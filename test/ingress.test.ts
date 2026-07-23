// OpenAI-compatible ingress: unit tests for the dialect translators plus
// integration tests running /v1/chat/completions and /v1/responses through the
// full Worker (dispatcher → router → mocked provider → reshape).
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  anthropicToChatResponse,
  anthropicToChatSSE,
  anthropicToResponsesResponse,
  anthropicToResponsesSSE,
  chatRequestToAnthropic,
  laneFromModel,
  responsesRequestToAnthropic,
} from '../src/adapters/ingress';
import type { AnthropicResponse } from '../src/adapters/types';
import type { RouterConfig } from '../src/worker/config';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// ---- unit: laneFromModel ----

describe('laneFromModel', () => {
  it('maps kompass-<lane> names and ignores everything else', () => {
    expect(laneFromModel('kompass-hard')).toBe('HARD');
    expect(laneFromModel('kompass-FAST')).toBe('FAST');
    expect(laneFromModel('kompass')).toBeUndefined();
    expect(laneFromModel('gpt-4o')).toBeUndefined();
    expect(laneFromModel(undefined)).toBeUndefined();
  });
});

// ---- unit: chat completions dialect ----

describe('chatRequestToAnthropic', () => {
  it('maps system, tools, tool_calls and tool messages', () => {
    const out = chatRequestToAnthropic({
      model: 'kompass',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
      ],
      tool_choice: 'required',
      max_tokens: 100,
    });
    expect(out.system).toBe('be terse');
    expect(out.max_tokens).toBe(100);
    expect(out.stream).toBe(false);
    expect(out.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'weather?' }],
    });
    expect(out.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Berlin' } },
    ]);
    expect(out.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' },
    ]);
    expect(out.tools?.[0]?.name).toBe('get_weather');
    expect(out.tool_choice).toEqual({ type: 'any' });
  });

  it('defaults max_tokens when the client omits it and merges same-role runs', () => {
    const out = chatRequestToAnthropic({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    expect(out.max_tokens).toBe(8192);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });
});

const SAMPLE: AnthropicResponse = {
  id: 'msg_abc',
  type: 'message',
  role: 'assistant',
  model: 'kompass',
  content: [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('anthropicToChatResponse / SSE', () => {
  it('produces a spec-shaped chat.completion with tool_calls', () => {
    const out = anthropicToChatResponse(SAMPLE, 'kompass') as never as {
      object: string;
      choices: Array<{
        message: { content: string; tool_calls: unknown[] };
        finish_reason: string;
      }>;
      usage: { total_tokens: number };
    };
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0]?.message.content).toBe('checking');
    expect(out.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(out.choices[0]?.finish_reason).toBe('tool_calls');
    expect(out.usage.total_tokens).toBe(15);
  });

  it('SSE burst ends with [DONE] and carries the content', () => {
    const sse = anthropicToChatSSE(SAMPLE, 'kompass', true);
    expect(sse).toContain('"role":"assistant"');
    expect(sse).toContain('"content":"checking"');
    expect(sse).toContain('"tool_calls"');
    expect(sse).toContain('"finish_reason":"tool_calls"');
    expect(sse).toContain('"total_tokens":15');
    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

// ---- unit: responses dialect (Codex) ----

describe('responsesRequestToAnthropic', () => {
  it('maps instructions, typed input items and function tools (flat format)', () => {
    const out = responsesRequestToAnthropic({
      model: 'kompass',
      instructions: 'you are codex',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        { type: 'function_call', call_id: 'call_9', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_9', output: 'a.txt' },
      ],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      max_output_tokens: 256,
    });
    expect(out.system).toBe('you are codex');
    expect(out.max_tokens).toBe(256);
    expect(out.messages[0]?.content).toEqual([{ type: 'text', text: 'list files' }]);
    expect(out.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'shell', input: { cmd: 'ls' } },
    ]);
    expect(out.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_9', content: 'a.txt' },
    ]);
    expect(out.tools?.[0]?.name).toBe('shell');
  });

  it('accepts a bare string input', () => {
    const out = responsesRequestToAnthropic({ input: 'hello' });
    expect(out.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

describe('anthropicToResponsesResponse / SSE', () => {
  it('emits message + function_call output items', () => {
    const out = anthropicToResponsesResponse(SAMPLE, 'kompass') as never as {
      object: string;
      status: string;
      output: Array<{ type: string; call_id?: string; arguments?: string }>;
      usage: { total_tokens: number };
    };
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.output[0]?.type).toBe('message');
    expect(out.output[1]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_1',
      arguments: '{"city":"Berlin"}',
    });
    expect(out.usage.total_tokens).toBe(15);
  });

  it('SSE stream carries created → deltas → completed in order', () => {
    const sse = anthropicToResponsesSSE(SAMPLE, 'kompass');
    const order = [
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.function_call_arguments.delta',
      'response.completed',
    ];
    let pos = -1;
    for (const evt of order) {
      const at = sse.indexOf(`event: ${evt}`);
      expect(at, evt).toBeGreaterThan(pos);
      pos = at;
    }
    expect(sse).toContain('"delta":"checking"');
  });
});

// ---- integration through the full Worker ----

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
    lanes: {
      AGENTIC: ['openrouter/model-a:free'],
      HARD: ['openrouter/model-hard:free'],
    },
  };
}

const AUTH = { 'content-type': 'application/json', authorization: 'Bearer test-bearer-token' };

function mockProvider(model: string, text: string) {
  fetchMock
    .get('https://openrouter.ai')
    .intercept({
      path: '/api/v1/chat/completions',
      method: 'POST',
      body: (b) => (JSON.parse(b as string) as { model: string }).model === model,
    })
    .reply(200, {
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(testConfig()));
});

describe('OpenAI-compatible endpoints (integration)', () => {
  it('/v1/chat/completions round-trips through the router', async () => {
    mockProvider('model-a:free', 'pong');
    const res = await SELF.fetch('https://kompass.test/v1/chat/completions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ model: 'kompass', messages: [{ role: 'user', content: 'ping' }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0]?.message.content).toBe('pong');
  });

  it('/v1/chat/completions streams a chunk burst ending in [DONE]', async () => {
    mockProvider('model-a:free', 'streamed-pong');
    const res = await SELF.fetch('https://kompass.test/v1/chat/completions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'kompass',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('streamed-pong');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('model name kompass-hard forces the HARD lane', async () => {
    mockProvider('model-hard:free', 'from-hard');
    const res = await SELF.fetch('https://kompass.test/v1/chat/completions', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'kompass-hard',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]?.message.content).toBe('from-hard');
  });

  it('/v1/responses round-trips (Codex dialect)', async () => {
    mockProvider('model-a:free', 'codex-pong');
    const res = await SELF.fetch('https://kompass.test/v1/responses', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ model: 'kompass', input: 'ping' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object: string;
      output: Array<{ type: string; content: Array<{ text: string }> }>;
    };
    expect(json.object).toBe('response');
    expect(json.output[0]?.content[0]?.text).toBe('codex-pong');
  });

  it('/v1/responses streams typed events', async () => {
    mockProvider('model-a:free', 'codex-stream');
    const res = await SELF.fetch('https://kompass.test/v1/responses', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ model: 'kompass', input: 'ping', stream: true }),
    });
    const text = await res.text();
    expect(text).toContain('event: response.created');
    expect(text).toContain('codex-stream');
    expect(text).toContain('event: response.completed');
  });

  it('/v1/models lists the kompass model ids (auth required)', async () => {
    const unauth = await SELF.fetch('https://kompass.test/v1/models');
    expect(unauth.status).toBe(401);
    const res = await SELF.fetch('https://kompass.test/v1/models', { headers: AUTH });
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((m) => m.id)).toContain('kompass-hard');
  });
});
