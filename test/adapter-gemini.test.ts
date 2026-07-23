import { describe, expect, it } from 'vitest';
import {
  anthropicToGemini,
  geminiToAnthropic,
  sanitizeSchemaForGemini,
  type GeminiResponse,
} from '../src/adapters/gemini';
import type { AnthropicRequest } from '../src/adapters/types';

describe('sanitizeSchemaForGemini', () => {
  it('strips unsupported keywords and keeps the useful subset', () => {
    const out = sanitizeSchemaForGemini({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string', description: 'City', format: 'uri', pattern: '^[a-z]+$' },
        count: { type: ['integer', 'null'], minimum: 0 },
        mode: { const: 'fast' },
      },
      required: ['city'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City' },
        count: { type: 'integer', nullable: true, minimum: 0 },
        mode: { enum: ['fast'], type: 'string' },
      },
      required: ['city'],
    });
  });

  it('converts oneOf to anyOf recursively', () => {
    const out = sanitizeSchemaForGemini({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(out.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });
});

const toolReq: AnthropicRequest = {
  model: 'claude-sonnet-4-5',
  max_tokens: 256,
  system: 'be helpful',
  tools: [
    {
      name: 'get_weather',
      description: 'weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ],
  messages: [
    { role: 'user', content: 'weather in Berlin?' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Berlin' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny, 21C' }],
    },
  ],
};

describe('anthropicToGemini', () => {
  it('maps system, tools, tool_use and tool_result (resolving the function name)', () => {
    const out = anthropicToGemini(toolReq);
    expect(out.systemInstruction).toEqual({ parts: [{ text: 'be helpful' }] });
    expect(out.tools?.[0]?.functionDeclarations[0]?.name).toBe('get_weather');
    expect(out.contents[0]).toEqual({ role: 'user', parts: [{ text: 'weather in Berlin?' }] });
    expect(out.contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: { name: 'get_weather', args: { city: 'Berlin' } },
          thoughtSignature: 'context_engineering_is_the_way_to_go',
        },
      ],
    });
    expect(out.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { result: 'sunny, 21C' } } }],
    });
    expect(out.generationConfig?.maxOutputTokens).toBe(256);
  });

  it('maps tool_choice any → mode ANY', () => {
    const out = anthropicToGemini({ ...toolReq, tool_choice: { type: 'any' } });
    expect(out.toolConfig?.functionCallingConfig.mode).toBe('ANY');
  });
});

describe('geminiToAnthropic', () => {
  it('maps text + functionCall parts, usage and stop_reason', () => {
    const res: GeminiResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'thinking...', thought: true },
              { text: 'Let me check. ' },
              { functionCall: { name: 'get_weather', args: { city: 'Berlin' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    };
    const out = geminiToAnthropic(res, 'claude-sonnet-4-5');
    expect(out.content[0]).toEqual({ type: 'text', text: 'Let me check. ' });
    expect(out.content[1]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    expect((out.content[1] as any).input).toEqual({ city: 'Berlin' });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 10 });
  });
});
