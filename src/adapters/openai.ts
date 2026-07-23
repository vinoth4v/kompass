// Anthropic ⇄ OpenAI chat-completions adapter. Kompass always calls upstream
// non-streaming (see router.ts) and synthesizes the client-facing SSE stream
// itself from a complete response — see messageToAnthropicSSE in router.ts.
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
  OpenAIToolCall,
} from './types';

function systemToString(system: AnthropicRequest['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

function blockText(
  content: string | Array<{ type: string; text?: string }> | undefined | null,
): string {
  // Tool-calls-only OpenAI-format responses set content: null (not undefined) —
  // seen live from NVIDIA, crashing this on `.filter` before this guard existed.
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b && b.type === 'text')
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
export function openAIToAnthropic(
  rawRes: OpenAIResponse,
  requestedModel: string,
): AnthropicResponse {
  // Providers occasionally return a 200 with a malformed/error-shaped body
  // (null, {}, missing choices) — seen live from OpenRouter and NVIDIA. Don't
  // crash on any of it; fall through to an empty translated response, which
  // router.ts treats as a failure and retries the next chain entry.
  const res = rawRes && typeof rawRes === 'object' ? rawRes : ({} as OpenAIResponse);
  const choice = res.choices?.[0];
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
  const msg = choice?.message;
  const text =
    typeof msg?.content === 'string'
      ? msg.content
      : blockText(msg?.content as Array<{ type: string; text?: string }> | null | undefined);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg?.tool_calls ?? []) {
    const fn = tc.function ?? {};
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: fn.name ?? '',
      input: safeParseJSON(typeof fn.arguments === 'string' ? fn.arguments : undefined),
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
