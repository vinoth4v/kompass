// Anthropic ⇄ Gemini generateContent adapter, including tool-schema translation
// both directions and SSE stream translation.
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStopReason,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
} from './types';

// ---- Gemini wire types (subset) ----

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  toolConfig?: {
    functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] };
  };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

// ---- Tool-schema translation (JSON Schema → Gemini-safe subset) ----

const KEEP_KEYS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'items',
  'nullable',
  'anyOf',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
]);

/**
 * Gemini's schema dialect rejects several JSON Schema keywords Claude Code tools use
 * ($schema, additionalProperties, format, const, oneOf…). Recursively strip to the
 * accepted subset; translate `type: [T,"null"]` → nullable, const → single-value enum,
 * oneOf → anyOf.
 */
export function sanitizeSchemaForGemini(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  let type = s.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (nonNull.length < type.length) out.nullable = true;
    type = nonNull[0] ?? 'string';
  }
  if (typeof type === 'string') out.type = type;

  if (s.const !== undefined) {
    out.enum = [s.const];
    if (!out.type)
      out.type =
        typeof s.const === 'number'
          ? 'number'
          : typeof s.const === 'boolean'
            ? 'boolean'
            : 'string';
  }

  const oneOf = s.oneOf ?? s.anyOf;
  if (Array.isArray(oneOf)) out.anyOf = oneOf.map((v) => sanitizeSchemaForGemini(v));

  for (const [k, v] of Object.entries(s)) {
    if (!KEEP_KEYS.has(k) || out[k] !== undefined) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = sanitizeSchemaForGemini(pv);
      }
      out.properties = props;
    } else if (k === 'items') {
      out.items = sanitizeSchemaForGemini(v);
    } else if (k === 'anyOf') {
      // handled above
    } else {
      out[k] = v;
    }
  }
  // Gemini requires object schemas to have a type.
  if (!out.type && !out.anyOf) out.type = 'object';
  return out;
}

function textOf(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** Translate an Anthropic Messages request into a Gemini generateContent request. */
export function anthropicToGemini(req: AnthropicRequest): GeminiRequest {
  // Gemini functionResponse needs the function *name*; Anthropic tool_result only
  // carries the tool_use_id — build the id→name map from prior assistant turns.
  const toolNameById = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
      }
    }
  }

  const contents: GeminiContent[] = [];
  for (const m of req.messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const b of m.content) {
        switch (b.type) {
          case 'text':
            parts.push({ text: b.text });
            break;
          case 'tool_use':
            parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
            break;
          case 'tool_result': {
            const name = toolNameById.get(b.tool_use_id) ?? 'unknown_tool';
            parts.push({
              functionResponse: {
                name,
                response: b.is_error
                  ? { error: textOf(b.content as never) }
                  : { result: textOf(b.content as never) },
              },
            });
            break;
          }
          case 'image':
            if (b.source.type === 'base64' && b.source.data) {
              parts.push({
                inlineData: {
                  mimeType: b.source.media_type ?? 'image/png',
                  data: b.source.data,
                },
              });
            }
            break;
          case 'thinking':
            break; // never replay thinking to a different model
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }

  const out: GeminiRequest = { contents };

  const sys =
    typeof req.system === 'string' ? req.system : req.system?.map((b) => b.text).join('\n\n');
  if (sys) out.systemInstruction = { parts: [{ text: sys }] };

  if (req.tools?.length) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchemaForGemini(t.input_schema),
        })),
      },
    ];
  }
  if (req.tool_choice) {
    const mode =
      req.tool_choice.type === 'any' || req.tool_choice.type === 'tool'
        ? 'ANY'
        : req.tool_choice.type === 'none'
          ? 'NONE'
          : 'AUTO';
    out.toolConfig = { functionCallingConfig: { mode } };
    if (req.tool_choice.type === 'tool')
      out.toolConfig.functionCallingConfig.allowedFunctionNames = [req.tool_choice.name];
  }

  out.generationConfig = { maxOutputTokens: req.max_tokens };
  if (req.temperature !== undefined) out.generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) out.generationConfig.topP = req.top_p;
  if (req.top_k !== undefined) out.generationConfig.topK = req.top_k;
  if (req.stop_sequences?.length) out.generationConfig.stopSequences = req.stop_sequences;

  return out;
}

function newToolId(): string {
  return `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function mapGeminiFinish(reason: string | undefined, sawToolCall: boolean): AnthropicStopReason {
  if (sawToolCall) return 'tool_use';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'STOP':
    default:
      return 'end_turn';
  }
}

/** Translate a non-streaming Gemini response into an Anthropic Messages response. */
export function geminiToAnthropic(res: GeminiResponse, requestedModel: string): AnthropicResponse {
  const cand = res.candidates?.[0];
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
  let sawToolCall = false;
  for (const part of cand?.content?.parts ?? []) {
    if (part.thought) continue;
    if (part.text) {
      const last = content[content.length - 1];
      if (last?.type === 'text') last.text += part.text;
      else content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      sawToolCall = true;
      content.push({
        type: 'tool_use',
        id: newToolId(),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }
  return {
    id: `msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapGeminiFinish(cand?.finishReason, sawToolCall),
    stop_sequence: null,
    usage: {
      input_tokens: res.usageMetadata?.promptTokenCount ?? 0,
      output_tokens:
        (res.usageMetadata?.candidatesTokenCount ?? 0) +
        (res.usageMetadata?.thoughtsTokenCount ?? 0),
    },
  };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Translate a Gemini streamGenerateContent?alt=sse stream into an Anthropic SSE stream.
 * Gemini sends whole functionCall parts (never partial JSON), so each becomes an
 * Anthropic tool_use block with a single input_json_delta.
 */
export function geminiStreamToAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  let started = false;
  let blockIndex = -1;
  let blockType: 'text' | 'thinking' | null = null;
  let sawToolCall = false;
  let finishReason: string | undefined;
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
    }
  }

  function openBlock(
    controller: TransformStreamDefaultController<Uint8Array>,
    type: 'text' | 'thinking',
  ) {
    if (blockType === type) return;
    closeBlock(controller);
    blockIndex++;
    blockType = type;
    controller.enqueue(
      encoder.encode(
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block:
            type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
        }),
      ),
    );
  }

  function handleChunk(
    chunk: GeminiResponse,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    emitStart(controller);
    if (chunk.usageMetadata) {
      usage = {
        input_tokens: chunk.usageMetadata.promptTokenCount ?? usage.input_tokens,
        output_tokens:
          (chunk.usageMetadata.candidatesTokenCount ?? 0) +
          (chunk.usageMetadata.thoughtsTokenCount ?? 0),
      };
    }
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    for (const part of cand?.content?.parts ?? []) {
      if (part.text !== undefined && part.text !== '') {
        if (part.thought) {
          openBlock(controller, 'thinking');
          controller.enqueue(
            encoder.encode(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'thinking_delta', thinking: part.text },
              }),
            ),
          );
        } else {
          openBlock(controller, 'text');
          controller.enqueue(
            encoder.encode(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: part.text },
              }),
            ),
          );
        }
      }
      if (part.functionCall) {
        sawToolCall = true;
        closeBlock(controller);
        blockIndex++;
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: newToolId(),
                name: part.functionCall.name,
                input: {},
              },
            }),
          ),
        );
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(part.functionCall.args ?? {}),
              },
            }),
          ),
        );
        controller.enqueue(
          encoder.encode(
            sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }),
          ),
        );
      }
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
          delta: { stop_reason: mapGeminiFinish(finishReason, sawToolCall), stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        }),
      ),
    );
    controller.enqueue(encoder.encode(sseEvent('message_stop', { type: 'message_stop' })));
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          handleChunk(JSON.parse(payload) as GeminiResponse, controller);
        } catch {
          // partial frame / keep-alive
        }
      }
    },
    flush(controller) {
      finish(controller);
    },
  });

  return upstream.pipeThrough(transform);
}
