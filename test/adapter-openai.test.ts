import { describe, expect, it } from 'vitest';
import { anthropicToOpenAI, openAIToAnthropic } from '../src/adapters/openai';
import type { AnthropicRequest, OpenAIResponse } from '../src/adapters/types';

const baseReq: AnthropicRequest = {
  model: 'claude-sonnet-4-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hello' }],
};

describe('anthropicToOpenAI', () => {
  it('maps system, messages, and sampling params', () => {
    const out = anthropicToOpenAI(
      { ...baseReq, system: 'be terse', temperature: 0.2, stop_sequences: ['END'] },
      'test/model',
    );
    expect(out.model).toBe('test/model');
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(out.temperature).toBe(0.2);
    expect(out.stop).toEqual(['END']);
    expect(out.max_tokens).toBe(100);
  });

  it('maps tools and tool_choice', () => {
    const out = anthropicToOpenAI(
      {
        ...baseReq,
        tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
        tool_choice: { type: 'any' },
      },
      'm',
    );
    expect(out.tools?.[0]?.function.name).toBe('f');
    expect(out.tool_choice).toBe('required');
  });

  it('maps assistant tool_use and user tool_result into OpenAI shape', () => {
    const out = anthropicToOpenAI(
      {
        ...baseReq,
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }],
          },
        ],
      },
      'm',
    );
    const assistant = out.messages[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: 'toolu_1',
      function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
    });
    const tool = out.messages[2]!;
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1', content: 'sunny' });
  });

  it('requests stream usage when streaming', () => {
    const out = anthropicToOpenAI({ ...baseReq, stream: true }, 'm');
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });
});

describe('openAIToAnthropic', () => {
  it('maps text + tool_calls + usage + finish_reason', () => {
    const res: OpenAIResponse = {
      id: 'abc',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hi',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = openAIToAnthropic(res, 'claude-sonnet-4-5');
    expect(out.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(out.content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', input: { a: 1 } });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.model).toBe('claude-sonnet-4-5');
  });

  it('handles content: null (tool-calls-only response) without throwing', () => {
    // Standard OpenAI-format behavior for a pure tool-call turn — seen live from
    // NVIDIA and crashed this adapter with a TypeError before this guard existed.
    const res: OpenAIResponse = {
      id: 'abc',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = openAIToAnthropic(res, 'claude-sonnet-4-5');
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'f', input: {} }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('handles a malformed body with no choices array without throwing', () => {
    // Seen live from OpenRouter: a 200 response shaped like an error body
    // ({} or {"error": ...}) with no `choices` at all — must translate to an
    // empty (zero-content) response, not throw, so router.ts's empty-content
    // guard can catch it and fall through to the next chain entry.
    const res = {} as OpenAIResponse;
    const out = openAIToAnthropic(res, 'claude-sonnet-4-5');
    expect(out.content).toEqual([]);
  });

  it('handles a bare null body without throwing', () => {
    const out = openAIToAnthropic(null as unknown as OpenAIResponse, 'claude-sonnet-4-5');
    expect(out.content).toEqual([]);
  });

  it('handles a tool_call with a missing function object without throwing', () => {
    const res: OpenAIResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function' } as never],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const out = openAIToAnthropic(res, 'claude-sonnet-4-5');
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_1', name: '', input: {} }]);
  });
});
