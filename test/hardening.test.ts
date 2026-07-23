// M5 acceptance: escalation state machine unit-tested; privacy guard blocks a
// seeded secret pattern from trains_on_data providers.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HARD_EXHAUSTED_NOTICE, laneUp, lastTurnHadToolError } from '../src/worker/escalation';
import { compilePrivacyGuard, globToRegExp, privacyMatch } from '../src/worker/privacy';
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
    default_lane: 'SIMPLE',
    allow_paid: false,
    privacy: {
      block_patterns: ['AKIA[0-9A-Z]{16}'],
      block_globs: ['**/.env', 'secrets/**'],
    },
    providers: {
      openrouter: {
        kind: 'openai',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        trains_on_data: true,
        limits: { rpm: 100, rpd: 5000 },
      },
      nvidia: {
        kind: 'openai',
        base_url: 'https://integrate.api.nvidia.com/v1',
        key_env: 'NVIDIA_API_KEY',
        trains_on_data: false,
        limits: { rpm: 100, rpd: 5000 },
      },
    },
    lanes: {
      SIMPLE: ['openrouter/trains:free', 'nvidia/clean-model'],
      AGENTIC: ['openrouter/trains:free', 'nvidia/clean-model'],
      HARD: ['nvidia/hard-model'],
    },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('escalation state machine (unit)', () => {
  it('laneUp follows FAST→SIMPLE→AGENTIC→HARD→null', () => {
    expect(laneUp('FAST')).toBe('SIMPLE');
    expect(laneUp('SIMPLE')).toBe('AGENTIC');
    expect(laneUp('AGENTIC')).toBe('HARD');
    expect(laneUp('HARD')).toBeNull();
    expect(laneUp('CUSTOM')).toBeNull();
  });

  it('lastTurnHadToolError inspects only the newest user turn', () => {
    const mk = (
      isError: boolean | undefined,
      tail?: AnthropicRequest['messages'],
    ): AnthropicRequest => ({
      model: 'm',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: isError }],
        },
        ...(tail ?? []),
      ],
    });
    expect(lastTurnHadToolError(mk(true))).toBe(true);
    expect(lastTurnHadToolError(mk(undefined))).toBe(false);
    // an error deeper in history followed by a clean user turn does not count
    expect(lastTurnHadToolError(mk(true, [{ role: 'user', content: 'try again' }]))).toBe(false);
  });
});

describe('privacy guard (unit)', () => {
  const guard = compilePrivacyGuard(cfg())!;
  const req = (text: string): AnthropicRequest => ({
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'user', content: text }],
  });

  it('matches a seeded AWS key pattern', () => {
    expect(privacyMatch(guard, req('here is cfg: AKIAIOSFODNN7EXAMPLE ok'))).toBe(true);
  });
  it('matches path globs', () => {
    expect(privacyMatch(guard, req('please cat deploy/.env for me'))).toBe(true);
    expect(privacyMatch(guard, req('read secrets/prod.json'))).toBe(true);
  });
  it('passes clean content', () => {
    expect(privacyMatch(guard, req('write a fizzbuzz in python'))).toBe(false);
  });
  it('globToRegExp anchors sensibly', () => {
    expect(globToRegExp('**/id_rsa').test('/home/u/.ssh/id_rsa')).toBe(true);
    expect(globToRegExp('**/id_rsa').test('no key material here')).toBe(false);
  });
});

describe('M5 integration', () => {
  it('privacy-sensitive request skips the trains_on_data provider', async () => {
    // only the clean (nvidia) interceptor exists — hitting openrouter would throw
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'safe' }, finish_reason: 'stop' }],
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        tools: [{ name: 't', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'why does AKIAIOSFODNN7EXAMPLE not work in my config?' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).content[0].text).toBe('safe');
  });

  it('3 consecutive failed tool turns escalate the session one lane up', async () => {
    const session = { user_id: 'user_x_session_esc-test' };
    const errBody = () =>
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        metadata: session,
        messages: [
          { role: 'user', content: 'fix the build please' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'exit 1', is_error: true },
            ],
          },
        ],
      });
    // No dispatcher in this config → tool-bearing requests ride AGENTIC. Turns 1–2:
    // failing tool_results served by openrouter; error counter climbs to 2.
    for (let i = 0; i < 2; i++) {
      fetchMock
        .get('https://openrouter.ai')
        .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
        .reply(200, {
          choices: [{ message: { role: 'assistant', content: 'retry' }, finish_reason: 'stop' }],
        });
      const r = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: AUTH,
        body: errBody(),
      });
      expect(r.status).toBe(200);
    }
    // Turn 3: counter hits 3 → AGENTIC escalates to HARD (nvidia/hard-model only).
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, {
        choices: [{ message: { role: 'assistant', content: 'big guns' }, finish_reason: 'stop' }],
      });
    const r3 = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: errBody(),
    });
    expect(r3.status).toBe(200);
    expect(((await r3.json()) as any).content[0].text).toBe('big guns');

    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    expect(status.routes[0]).toMatchObject({ lane: 'HARD', entry: 'nvidia/hard-model', ok: true });
  });

  it('HARD exhausted → synthetic "switch to native claude" notice (200, not 529)', async () => {
    fetchMock
      .get('https://integrate.api.nvidia.com')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(503, { error: 'no capacity' });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-lane': 'HARD' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        tools: [{ name: 't', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'prove P=NP' }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.role).toBe('assistant');
    expect(json.content[0].text).toBe(HARD_EXHAUSTED_NOTICE);
  });
});
