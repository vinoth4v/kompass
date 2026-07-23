// OpenAI-compatible INGRESS adapters: let OpenAI-dialect clients (Cursor, Cline,
// Roo Code, Continue, Aider → /v1/chat/completions; Codex → /v1/responses) talk
// to Kompass. Inbound requests are translated to the internal Anthropic Messages
// shape and run through the normal dispatcher/router pipeline; the buffered
// AnthropicResponse is then reshaped (JSON or a synthesized SSE burst) to match
// what each dialect's client expects. Mirrors the buffer-then-emit design in
// router.ts — streams are synthesized from complete responses, never live.
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
} from './types';

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** kompass-hard / kompass-fast / … model names force a lane; anything else → auto. */
export function laneFromModel(model: string | undefined): string | undefined {
  const m = model?.match(/^kompass[-_.](fast|simple|agentic|hard|longctx)$/i);
  return m?.[1] ? m[1].toUpperCase() : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// Chat Completions dialect (/v1/chat/completions)
// ════════════════════════════════════════════════════════════════════════════

export interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{
    role: string;
    content?: string | Array<Record<string, unknown>> | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: string | { type?: string; function?: { name?: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

function partsToText(content: string | Array<Record<string, unknown>> | null | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p && (p.type === 'text' || p.type === 'input_text'))
    .map((p) => String(p.text ?? ''))
    .join('\n');
}

/** Push a message, merging into the previous one when roles match (Anthropic
 *  wants alternating turns; OpenAI clients often send runs of same-role msgs). */
function pushMerged(
  out: AnthropicMessage[],
  role: 'user' | 'assistant',
  blocks: AnthropicContentBlock[],
): void {
  if (blocks.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    (last.content as AnthropicContentBlock[]).push(...blocks);
  } else {
    out.push({ role, content: blocks });
  }
}

export function chatRequestToAnthropic(req: ChatCompletionRequest): AnthropicRequest {
  const systems: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of req.messages ?? []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') {
      systems.push(partsToText(m.content));
    } else if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const text = partsToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id ?? newId('toolu'),
          name: tc.function?.name ?? '',
          input: safeParse(tc.function?.arguments),
        });
      }
      pushMerged(messages, 'assistant', blocks);
    } else if (m.role === 'tool') {
      pushMerged(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: partsToText(m.content),
        },
      ]);
    } else {
      // user (and anything unrecognized — treat as user)
      const text = partsToText(m.content);
      pushMerged(messages, 'user', text ? [{ type: 'text', text }] : []);
    }
  }

  const out: AnthropicRequest = {
    model: req.model ?? 'kompass',
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? 8192,
    messages,
    stream: false,
  };
  if (systems.length) out.system = systems.join('\n\n');
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  if (req.tools?.length) {
    out.tools = req.tools
      .filter((t) => t?.function?.name)
      .map((t) => ({
        name: t.function?.name ?? '',
        description: t.function?.description,
        input_schema: t.function?.parameters ?? { type: 'object' },
      }));
  }
  if (req.tool_choice) {
    if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (req.tool_choice === 'none') out.tool_choice = { type: 'none' };
    else if (req.tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (typeof req.tool_choice === 'object' && req.tool_choice.function?.name)
      out.tool_choice = { type: 'tool', name: req.tool_choice.function.name };
  }
  return out;
}

function chatFinishReason(stop: AnthropicResponse['stop_reason']): string {
  if (stop === 'max_tokens') return 'length';
  if (stop === 'tool_use') return 'tool_calls';
  return 'stop';
}

interface ChatMessageOut {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

function chatMessageFromAnthropic(msg: AnthropicResponse): ChatMessageOut {
  const text = msg.content
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = msg.content
    .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const out: ChatMessageOut = { role: 'assistant', content: text || null };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

export function anthropicToChatResponse(
  msg: AnthropicResponse,
  model: string,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${msg.id.replace(/^msg_/, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: chatMessageFromAnthropic(msg),
        finish_reason: chatFinishReason(msg.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: msg.usage.input_tokens,
      completion_tokens: msg.usage.output_tokens,
      total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
    },
  };
}

/** Synthesized chat.completion.chunk SSE burst from a complete response. */
export function anthropicToChatSSE(
  msg: AnthropicResponse,
  model: string,
  includeUsage = false,
): string {
  const id = `chatcmpl-${msg.id.replace(/^msg_/, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  const m = chatMessageFromAnthropic(msg);
  let out = chunk({ role: 'assistant' }, null);
  if (m.content) out += chunk({ content: m.content }, null);
  if (m.tool_calls?.length) {
    out += chunk(
      {
        tool_calls: m.tool_calls.map((tc, i) => ({
          index: i,
          id: tc.id,
          type: 'function',
          function: tc.function,
        })),
      },
      null,
    );
  }
  out += chunk({}, chatFinishReason(msg.stop_reason));
  if (includeUsage) {
    out += `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: msg.usage.input_tokens,
        completion_tokens: msg.usage.output_tokens,
        total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
      },
    })}\n\n`;
  }
  return out + 'data: [DONE]\n\n';
}

// ════════════════════════════════════════════════════════════════════════════
// Responses API dialect (/v1/responses — what Codex CLI speaks)
// ════════════════════════════════════════════════════════════════════════════

export interface ResponsesRequest {
  model?: string;
  input?: string | Array<Record<string, unknown>>;
  instructions?: string;
  tools?: Array<{
    type?: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  tool_choice?: string | { type?: string; name?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export function responsesRequestToAnthropic(req: ResponsesRequest): AnthropicRequest {
  const systems: string[] = [];
  if (req.instructions) systems.push(req.instructions);
  const messages: AnthropicMessage[] = [];

  const items =
    typeof req.input === 'string'
      ? [{ type: 'message', role: 'user', content: req.input }]
      : (req.input ?? []);

  for (const item of items) {
    if (!item) continue;
    const type = String(item.type ?? 'message');
    if (type === 'message') {
      const role = String(item.role ?? 'user');
      const text = partsToText(item.content as never);
      if (role === 'system' || role === 'developer') {
        if (text) systems.push(text);
      } else if (role === 'assistant') {
        pushMerged(messages, 'assistant', text ? [{ type: 'text', text }] : []);
      } else {
        pushMerged(messages, 'user', text ? [{ type: 'text', text }] : []);
      }
    } else if (type === 'function_call') {
      pushMerged(messages, 'assistant', [
        {
          type: 'tool_use',
          id: String(item.call_id ?? item.id ?? newId('toolu')),
          name: String(item.name ?? ''),
          input: safeParse(item.arguments),
        },
      ]);
    } else if (type === 'function_call_output') {
      pushMerged(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: String(item.call_id ?? ''),
          content:
            typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        },
      ]);
    } else if (type === 'reasoning') {
      // replayed reasoning items from a previous turn — never forward
    }
  }

  const out: AnthropicRequest = {
    model: req.model ?? 'kompass',
    max_tokens: req.max_output_tokens ?? 8192,
    messages,
    stream: false,
  };
  if (systems.length) out.system = systems.join('\n\n');
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools?.length) {
    out.tools = req.tools
      .filter((t) => t && (t.type === 'function' || !t.type) && t.name)
      .map((t) => ({
        name: t.name ?? '',
        description: t.description,
        input_schema: t.parameters ?? { type: 'object' },
      }));
  }
  if (req.tool_choice === 'required') out.tool_choice = { type: 'any' };
  else if (req.tool_choice === 'none') out.tool_choice = { type: 'none' };
  return out;
}

interface ResponsesOutputItem {
  type: string;
  id: string;
  status: 'completed';
  role?: 'assistant';
  content?: Array<{ type: 'output_text'; text: string; annotations: [] }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}

function responsesOutput(msg: AnthropicResponse): ResponsesOutputItem[] {
  const out: ResponsesOutputItem[] = [];
  const text = msg.content
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (text) {
    out.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const b of msg.content) {
    if (b.type !== 'tool_use') continue;
    out.push({
      type: 'function_call',
      id: newId('fc'),
      status: 'completed',
      call_id: b.id,
      name: b.name,
      arguments: JSON.stringify(b.input ?? {}),
    });
  }
  return out;
}

function responsesEnvelope(
  msg: AnthropicResponse,
  model: string,
  id: string,
  status: 'in_progress' | 'completed',
  output: ResponsesOutputItem[],
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage:
      status === 'completed'
        ? {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
          }
        : null,
    error: null,
    incomplete_details: null,
  };
}

export function anthropicToResponsesResponse(
  msg: AnthropicResponse,
  model: string,
): Record<string, unknown> {
  return responsesEnvelope(msg, model, newId('resp'), 'completed', responsesOutput(msg));
}

/** Synthesized Responses-API SSE event stream from a complete response. */
export function anthropicToResponsesSSE(msg: AnthropicResponse, model: string): string {
  const respId = newId('resp');
  const items = responsesOutput(msg);
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;

  let out = ev('response.created', {
    response: responsesEnvelope(msg, model, respId, 'in_progress', []),
  });
  items.forEach((item, output_index) => {
    if (item.type === 'message') {
      const text = item.content?.[0]?.text ?? '';
      out += ev('response.output_item.added', {
        output_index,
        item: { ...item, status: 'in_progress', content: [] },
      });
      out += ev('response.content_part.added', {
        item_id: item.id,
        output_index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      out += ev('response.output_text.delta', {
        item_id: item.id,
        output_index,
        content_index: 0,
        delta: text,
      });
      out += ev('response.output_text.done', {
        item_id: item.id,
        output_index,
        content_index: 0,
        text,
      });
      out += ev('response.content_part.done', {
        item_id: item.id,
        output_index,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      });
    } else {
      out += ev('response.output_item.added', {
        output_index,
        item: { ...item, status: 'in_progress', arguments: '' },
      });
      out += ev('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index,
        delta: item.arguments ?? '',
      });
      out += ev('response.function_call_arguments.done', {
        item_id: item.id,
        output_index,
        arguments: item.arguments ?? '',
      });
    }
    out += ev('response.output_item.done', { output_index, item });
  });
  out += ev('response.completed', {
    response: responsesEnvelope(msg, model, respId, 'completed', items),
  });
  return out;
}
