// Talks directly to a Kompass Worker (cross-origin — see the Worker's CORS
// middleware in src/worker/index.ts). The bearer never leaves the browser
// except as the Authorization header on these requests — same trust model as
// the Worker's own status.html dashboard, just as a full app instead of one
// HTML file. Every call is non-streaming: Kompass always resolves the
// complete answer server-side before replying (buffer-then-emit), so a plain
// JSON round trip is exactly as fast as consuming an SSE stream would be,
// without any parsing complexity on this end.
import type { KompassSettings } from './types';

export interface AnthropicTextBlockWire {
  type: 'text';
  text: string;
}
export interface AnthropicImageBlockWire {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
export interface AnthropicToolUseBlockWire {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface AnthropicToolResultBlockWire {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type AnthropicContentBlockWire =
  | AnthropicTextBlockWire
  | AnthropicImageBlockWire
  | AnthropicToolUseBlockWire
  | AnthropicToolResultBlockWire;

export interface AnthropicMessageWire {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlockWire[];
}

export interface AnthropicToolWire {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface SendMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageWire[];
  tools?: AnthropicToolWire[];
}

export interface AnthropicResponseWire {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicContentBlockWire>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class KompassApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'KompassApiError';
  }
}

function baseUrl(settings: KompassSettings): string {
  return settings.workerUrl.replace(/\/$/, '');
}

function headers(settings: KompassSettings, extra?: Record<string, string>): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${settings.bearer}`,
    ...extra,
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
    // body wasn't JSON — fall through to a generic message
  }
  if (res.status === 401) return 'Invalid bearer token.';
  if (res.status === 503) return 'Worker has no config pushed yet (kompass config push).';
  return `Request failed (HTTP ${res.status}).`;
}

/** Lightweight, quota-free check used by the login screen. */
export async function verifyConnection(
  workerUrl: string,
  bearer: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/v1/models`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return { ok: false, error: await readErrorMessage(res) };
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        'Could not reach the Worker — check the URL, and that it allows cross-origin requests.',
    };
  }
}

export interface SendMessageResult {
  response: AnthropicResponseWire;
  servedBy: string | null;
  lane: string | null;
}

export async function sendMessage(
  settings: KompassSettings,
  req: SendMessageRequest,
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  const res = await fetch(`${baseUrl(settings)}/v1/messages`, {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new KompassApiError(res.status, await readErrorMessage(res));
  const response = (await res.json()) as AnthropicResponseWire;
  return {
    response,
    servedBy: res.headers.get('x-kompass-served-by'),
    lane: res.headers.get('x-kompass-lane'),
  };
}

export interface GenerateImageResult {
  b64: string;
  mime: string;
  model: string;
}

export async function generateImage(
  settings: KompassSettings,
  prompt: string,
  signal?: AbortSignal,
): Promise<GenerateImageResult> {
  const res = await fetch(`${baseUrl(settings)}/v1/images/generations`, {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok) throw new KompassApiError(res.status, await readErrorMessage(res));
  const body = (await res.json()) as {
    data: { b64_json: string }[];
    model: string;
    mime_type: string;
  };
  const first = body.data[0];
  if (!first) throw new KompassApiError(502, 'No image returned.');
  return { b64: first.b64_json, mime: body.mime_type, model: body.model };
}
