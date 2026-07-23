// Anthropic ⇄ OpenAI chat-completions adapter, including SSE stream translation.
import type {
  AnthropicContentBlock,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStopReason,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIToolCall,
} from './types';

function systemToString(system: AnthropicRequest['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

function blockText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** Translate an Anthropic Messages request into an OpenAI chat-completions request. */
export function anthropicToOpenAI(req: AnthropicRequest, model: string): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  const sys = systemToString(req.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is AnthropicTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls: OpenAIToolCall[] = m.content
        .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: OpenAIMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      // User message: tool_result blocks become role:"tool" messages (must directly
      // follow the assistant tool_calls message); remaining content becomes a user message.
      const rest: AnthropicContentBlock[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: blockText(b.content as never) || (b.is_error ? 'Error' : ''),
          });
        } else {
          rest.push(b);
        }
      }
      if (rest.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        for (const b of rest) {
          if (b.type === 'text') parts.push({ type: 'text', text: b.text });
          else if (b.type === 'image' && b.source.type === 'base64') {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            });
          } else if (b.type === 'image' && b.source.type === 'url') {
            parts.push({ type: 'image_url', image_url: { url: b.source.url } });
          }
        }
        const onlyText = parts.every((p) => p.type === 'text');
        messages.push({
          role: 'user',
          content: onlyText ? parts.map((p) => p.text as string).join('\n') : parts,
        });
      }
    }
  }

  const out: OpenAIRequest = {
    model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream ?? false,
  };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.stream) out.stream_options = { include_usage: true };

  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  if (req.tool_choice) {
    switch (req.tool_choice.type) {
      case 'auto':
        out.tool_choice = 'auto';
        break;
      case 'any':
        out.tool_choice = 'required';
        break;
      case 'none':
        out.tool_choice = 'none';
        break;
      case 'tool':
        out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
        break;
    }
  }
  return out;
}

export function mapFinishReason(reason: string | null | undefined): AnthropicStopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function safeParseJSON(s: string | undefined): Record<string, unknown> {
  if (!s || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Translate a non-streaming OpenAI response into an Anthropic Messages response. */
export function openAIToAnthropic(res: OpenAIResponse, requestedModel: string): AnthropicResponse {
  const choice = res.choices[0];
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
  const msg = choice?.message;
  const text = typeof msg?.content === 'string' ? msg.content : blockText(msg?.content as never);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: tc.function.name ?? '',
      input: safeParseJSON(tc.function.arguments),
    });
  }
  return {
    id: `msg_${(res.id ?? crypto.randomUUID()).replaceAll('-', '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Translate an OpenAI SSE stream into an Anthropic SSE stream.
 * Input: raw bytes of the upstream OpenAI `text/event-stream`.
 * Output: bytes of an Anthropic-protocol `text/event-stream`.
 */
export function openAIStreamToAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  let started = false;
  let blockIndex = -1;
  let blockType: 'text' | 'tool_use' | 'thinking' | null = null;
  let currentToolIndex: number | null = null;
  let stopReason: AnthropicStopReason | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finished = false;
  const msgId = `msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

  function emitStart(controller: TransformStreamDefaultController<Uint8Array>) {
    if (started) return;
    started = true;
    controller.enqueue(
      encoder.encode(
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      ),
    );
  }

  function closeBlock(controller: TransformStreamDefaultController<Uint8Array>) {
    if (blockType !== null) {
      controller.enqueue(
        encoder.encode(
          sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }),
        ),
      );
      blockType = null;
      currentToolIndex = null;
    }
  }

  function finish(controller: TransformStreamDefaultController<Uint8Array>) {
    if (finished) return;
    finished = true;
    emitStart(controller);
    closeBlock(controller);
    controller.enqueue(
      encoder.encode(
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        }),
      ),
    );
    controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
  }

  function handleChunk(
    chunk: OpenAIStreamChunk,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    emitStart(controller);
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;

    // Reasoning models (e.g. OpenRouter `reasoning`, some providers `reasoning_content`)
    // stream thinking tokens before any text — surface them as Anthropic thinking blocks
    // so long silences don't look like a stalled stream.
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning) {
      if (blockType !== 'thinking') {
        closeBlock(controller);
        blockIndex++;
        blockType = 'thinking';
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'thinking', thinking: '' },
            }),
          ),
        );
      }
      controller.enqueue(
        encoder.encode(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'thinking_delta', thinking: reasoning },
          }),
        ),
      );
    }

    if (delta?.content) {
      if (blockType !== 'text') {
        closeBlock(controller);
        blockIndex++;
        blockType = 'text';
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            }),
          ),
        );
      }
      controller.enqueue(
        encoder.encode(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: delta.content },
          }),
        ),
      );
    }

    for (const tc of delta?.tool_calls ?? []) {
      const tcIndex = tc.index ?? 0;
      if (blockType !== 'tool_use' || currentToolIndex !== tcIndex) {
        closeBlock(controller);
        blockIndex++;
        blockType = 'tool_use';
        currentToolIndex = tcIndex;
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: tc.id ?? `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
                name: tc.function?.name ?? '',
                input: {},
              },
            }),
          ),
        );
      }
      if (tc.function?.arguments) {
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }),
          ),
        );
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      // SSE frames are separated by a blank line; individual lines start with "data: ".
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          finish(controller);
          continue;
        }
        try {
          handleChunk(JSON.parse(payload) as OpenAIStreamChunk, controller);
        } catch {
          // Ignore unparsable keep-alives / partial frames.
        }
      }
    },
    flush(controller) {
      finish(controller);
    },
  });

  return upstream.pipeThrough(transform);
}
