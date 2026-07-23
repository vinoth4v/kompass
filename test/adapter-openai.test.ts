import { describe, expect, it } from 'vitest';
import {
  anthropicToOpenAI,
  openAIStreamToAnthropicStream,
  openAIToAnthropic,
} from '../src/adapters/openai';
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
});

function openAISSE(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function collectSSE(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  const events: Array<{ event: string; data: any }> = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) current = line.slice(6).trim();
    else if (line.startsWith('data:'))
      events.push({ event: current, data: JSON.parse(line.slice(5)) });
  }
  return events;
}

describe('openAIStreamToAnthropicStream', () => {
  it('translates a text stream into Anthropic events', async () => {
    const events = await collectSSE(
      openAIStreamToAnthropicStream(
        openAISSE([
          { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 2 } },
        ]),
        'claude-sonnet-4-5',
      ),
    );
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('message_start');
    expect(kinds).toContain('content_block_start');
    expect(kinds[kinds.length - 1]).toBe('message_stop');
    const text = events
      .filter((e) => e.data.delta?.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('');
    expect(text).toBe('Hello');
    const md = events.find((e) => e.event === 'message_delta')!;
    expect(md.data.delta.stop_reason).toBe('end_turn');
    expect(md.data.usage.output_tokens).toBe(2);
  });

  it('surfaces reasoning deltas as a thinking block before the text block', async () => {
    const events = await collectSSE(
      openAIStreamToAnthropicStream(
        openAISSE([
          { choices: [{ delta: { reasoning: 'hmm, ' } }] },
          { choices: [{ delta: { reasoning: 'pong it is' } }] },
          { choices: [{ delta: { content: 'pong' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        'm',
      ),
    );
    const starts = events.filter((e) => e.event === 'content_block_start');
    expect(starts[0]!.data.content_block.type).toBe('thinking');
    expect(starts[1]!.data.content_block.type).toBe('text');
    const thinking = events
      .filter((e) => e.data.delta?.type === 'thinking_delta')
      .map((e) => e.data.delta.thinking)
      .join('');
    expect(thinking).toBe('hmm, pong it is');
    // the thinking block must be closed before the text block opens
    const kinds = events.map((e) => e.event);
    expect(kinds.indexOf('content_block_stop')).toBeLessThan(
      kinds.lastIndexOf('content_block_start'),
    );
  });

  it('translates streamed tool calls into tool_use blocks with input_json_delta', async () => {
    const events = await collectSSE(
      openAIStreamToAnthropicStream(
        openAISSE([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_9', function: { name: 'get_weather', arguments: '' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"Berlin"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        'm',
      ),
    );
    const start = events.find((e) => e.event === 'content_block_start')!;
    expect(start.data.content_block).toMatchObject({
      type: 'tool_use',
      id: 'call_9',
      name: 'get_weather',
    });
    const json = events
      .filter((e) => e.data.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ city: 'Berlin' });
    expect(events.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe(
      'tool_use',
    );
  });

  it('emits a well-formed empty message when upstream sends nothing', async () => {
    const events = await collectSSE(openAIStreamToAnthropicStream(openAISSE([]), 'm'));
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });

  it('truncated stream (content then EOF without finish/[DONE]) → in-stream error, no message_stop', async () => {
    // provider died cleanly mid-answer: the client must retry, not accept the turn
    const enc = new TextEncoder();
    const truncated = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'partial answ' } }] })}\n\n`,
          ),
        );
        c.close(); // clean EOF — no finish_reason, no [DONE]
      },
    });
    let aborted = false;
    const events = await collectSSE(
      openAIStreamToAnthropicStream(truncated, 'm', undefined, () => (aborted = true)),
    );
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('error');
    expect(kinds).not.toContain('message_stop');
    expect(events.find((e) => e.event === 'error')!.data.error.type).toBe('overloaded_error');
    expect(aborted).toBe(true);
  });
});
