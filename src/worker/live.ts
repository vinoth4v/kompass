// Hybrid live streaming for the native Claude Code dialect (2026-07-23,
// relaxes the pure buffer-then-emit design in router.ts):
//
// Upstream is called WITH streaming and Kompass forwards text deltas to the
// client as they arrive — but only after the first content token shows up.
// Every failure before that first token (bad status, garbled body, timeout,
// empty stream) stays invisible: the router just falls through to the next
// chain entry, exactly like the buffered path. Once text is flowing, a
// mid-generation provider death can no longer be retried invisibly — instead
// the stream is closed GRACEFULLY (proper content_block_stop / message_delta /
// message_stop), so Claude Code sees a short-but-completed turn and carries
// on. It never sees a protocol error needing a manual --continue.
//
// Tool calls are never streamed incrementally: their JSON args accumulate
// server-side and each tool_use block is emitted (as one burst at stream end)
// only if its args parse. A tool call truncated by a mid-stream death is
// dropped entirely rather than risk handing Claude Code malformed input. A
// turn that is pure tool calls therefore still behaves exactly like
// buffer-then-emit — there is no prose to watch on such turns anyway.
import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStopReason,
  AnthropicToolUseBlock,
} from '../adapters/types';
import { anthropicToOpenAI, mapFinishReason } from '../adapters/openai';
import { anthropicToGemini } from '../adapters/gemini';
import type { ProviderConfig } from './config';

// Headers must arrive fast even on cold starts; the first content token gets
// the same 90s total budget the buffered path had; a silent gap mid-stream is
// treated as a stall much sooner.
const HEADERS_TIMEOUT_MS = 30_000;
const FIRST_CONTENT_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 45_000;

export interface LiveUsage {
  input_tokens: number;
  output_tokens: number;
}

export type LiveResult =
  /** Committed: text is streaming to the client; usage resolves at stream end. */
  | { kind: 'live'; response: Response; done: Promise<LiveUsage> }
  /** Provider ignored the stream request and sent plain JSON — caller translates. */
  | { kind: 'json'; json: unknown }
  /** Stream ended before any text (e.g. pure tool calls) — complete message. */
  | { kind: 'complete'; message: AnthropicResponse }
  | { kind: 'fail'; status: number | string; detail?: string };

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
};

interface ToolAcc {
  id?: string;
  name?: string;
  /** OpenAI-style streamed argument fragments; parsed only when complete. */
  args: string;
  /** Gemini delivers args as a complete object in one chunk. */
  input?: Record<string, unknown>;
}

/** Minimal structural shape of an OpenAI chat.completion.chunk. */
interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Minimal structural shape of a streamed Gemini GenerateContentResponse. */
interface GeminiChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export async function tryLiveEntry(
  p: ProviderConfig,
  key: string,
  body: AnthropicRequest,
  model: string,
): Promise<LiveResult> {
  const isGemini = p.kind === 'gemini';
  let url: string;
  let init: RequestInit;
  if (isGemini) {
    url = `${p.base_url}/models/${model}:streamGenerateContent?alt=sse`;
    init = {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(anthropicToGemini({ ...body, stream: false })),
    };
  } else {
    const oai = anthropicToOpenAI({ ...body, stream: true }, model);
    // Some free providers reject stream_options; usage is estimated instead.
    delete (oai as { stream_options?: unknown }).stream_options;
    url = `${p.base_url}/chat/completions`;
    init = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'http-referer': 'https://github.com/vinoth4v/kompass',
        'x-title': 'Kompass',
      },
      body: JSON.stringify(oai),
    };
  }

  const started = Date.now();
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort('kompass-idle'), ms);
  };

  let upstream: Response;
  try {
    arm(HEADERS_TIMEOUT_MS);
    upstream = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(idle);
    return {
      kind: 'fail',
      status: ctrl.signal.aborted ? 'timeout' : 'error',
      detail: String(e).slice(0, 200),
    };
  }
  if (!upstream.ok) {
    clearTimeout(idle);
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    return { kind: 'fail', status: upstream.status, detail };
  }
  const ctype = upstream.headers.get('content-type') ?? '';
  if (!ctype.includes('text/event-stream')) {
    clearTimeout(idle);
    try {
      return { kind: 'json', json: await upstream.json() };
    } catch {
      return { kind: 'fail', status: 'error', detail: 'non-SSE, non-JSON body' };
    }
  }
  if (!upstream.body) {
    clearTimeout(idle);
    return { kind: 'fail', status: 'error', detail: 'no response body' };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let bufText = '';

  let text = '';
  const tools: ToolAcc[] = [];
  let finish: string | undefined;
  let usage: LiveUsage | undefined;

  /** Fold one parsed SSE chunk into the accumulators; returns its text delta. */
  const handleChunk = (obj: unknown): string => {
    if (!obj || typeof obj !== 'object') return '';
    let delta = '';
    if (isGemini) {
      const cand = (obj as GeminiChunk).candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (typeof part?.text === 'string') delta += part.text;
        else if (part?.functionCall) {
          tools.push({
            name: part.functionCall.name,
            args: '',
            input: part.functionCall.args ?? {},
          });
        }
      }
      if (cand?.finishReason)
        finish = cand.finishReason === 'MAX_TOKENS' ? 'length' : cand.finishReason;
      const um = (obj as GeminiChunk).usageMetadata;
      if (um) {
        usage = {
          input_tokens: um.promptTokenCount ?? 0,
          output_tokens: um.candidatesTokenCount ?? 0,
        };
      }
    } else {
      const choice = (obj as OpenAIChunk).choices?.[0];
      const d = choice?.delta ?? {};
      if (typeof d.content === 'string') delta += d.content;
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : tools.length;
        tools[i] ??= { args: '' };
        if (tc.id) tools[i].id = tc.id;
        if (tc.function?.name) tools[i].name = (tools[i].name ?? '') + tc.function.name;
        if (typeof tc.function?.arguments === 'string') tools[i].args += tc.function.arguments;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      const u = (obj as OpenAIChunk).usage;
      if (u)
        usage = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 };
    }
    if (delta) text += delta;
    return delta;
  };

  const finalTools = (): AnthropicToolUseBlock[] => {
    const out: AnthropicToolUseBlock[] = [];
    for (const t of tools) {
      if (!t) continue;
      let input = t.input;
      if (input === undefined) {
        if (!t.args.trim()) input = {};
        else {
          try {
            input = JSON.parse(t.args) as Record<string, unknown>;
          } catch {
            console.log(`live: dropping truncated tool_use "${t.name ?? ''}"`);
            continue;
          }
        }
      }
      out.push({
        type: 'tool_use',
        id: t.id ?? `toolu_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
        name: t.name ?? '',
        input,
      });
    }
    return out;
  };

  const finalUsage = (): LiveUsage =>
    usage ?? {
      input_tokens: 0,
      output_tokens: Math.ceil(
        (text.length + tools.reduce((n, t) => n + (t?.args.length ?? 0), 0)) / 4,
      ),
    };

  const stopReason = (toolBlocks: number): AnthropicStopReason =>
    toolBlocks > 0 ? 'tool_use' : mapFinishReason(finish);

  const msgId = `msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

  const buildMessage = (): AnthropicResponse => {
    const tb = finalTools();
    const content: AnthropicResponse['content'] = [];
    if (text) content.push({ type: 'text', text });
    content.push(...tb);
    return {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: stopReason(tb.length),
      stop_sequence: null,
      usage: finalUsage(),
    };
  };

  const enc = new TextEncoder();
  return await new Promise<LiveResult>((resolve) => {
    let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
    let resolveDone!: (u: LiveUsage) => void;
    const done = new Promise<LiveUsage>((r) => (resolveDone = r));
    const write = (s: string) => sink?.enqueue(enc.encode(s));
    let committed = false;

    const commit = (firstDelta: string) => {
      // start() runs synchronously on construction, so sink is set before write.
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          sink = c;
        },
      });
      write(
        sse('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
      write(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: firstDelta },
        }),
      );
      committed = true;
      resolve({ kind: 'live', response: new Response(stream, { headers: SSE_HEADERS }), done });
    };

    const close = () => {
      clearTimeout(idle);
      if (!committed) {
        resolve({ kind: 'complete', message: buildMessage() });
        return;
      }
      const tb = finalTools();
      write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      tb.forEach((b, i) => {
        const index = i + 1;
        write(
          sse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
          }),
        );
        write(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
          }),
        );
        write(sse('content_block_stop', { type: 'content_block_stop', index }));
      });
      const u = finalUsage();
      write(
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason(tb.length), stop_sequence: null },
          usage: { output_tokens: u.output_tokens },
        }),
      );
      write(sse('message_stop', { type: 'message_stop' }));
      try {
        sink?.close();
      } catch {
        // client already disconnected
      }
      resolveDone(u);
    };

    void (async () => {
      try {
        for (;;) {
          const remainingFirst = FIRST_CONTENT_TIMEOUT_MS - (Date.now() - started);
          arm(committed ? IDLE_TIMEOUT_MS : Math.max(1, Math.min(IDLE_TIMEOUT_MS, remainingFirst)));
          const { done: eof, value } = await reader.read();
          if (eof) break;
          bufText += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = bufText.indexOf('\n')) !== -1) {
            const line = bufText.slice(0, nl).trim();
            bufText = bufText.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let obj: unknown;
            try {
              obj = JSON.parse(payload);
            } catch {
              continue;
            }
            const delta = handleChunk(obj);
            if (!delta) continue;
            if (!committed) commit(delta);
            else {
              write(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: delta },
                }),
              );
            }
          }
        }
      } catch (e) {
        // Idle abort or upstream death. Post-commit this closes gracefully
        // below; pre-commit it yields a (possibly empty) complete message,
        // which the router treats as an ordinary failure and falls through.
        console.log(`live stream ended abnormally: ${String(e).slice(0, 120)}`);
      }
      close();
    })();
  });
}
