// M5 failure escalation (SPEC §4): ≥3 consecutive failed tool iterations on a lane
// → escalate one lane up; when HARD is exhausted, a synthetic assistant notice tells
// the user to switch back to native claude.
import type { AnthropicRequest } from '../adapters/types';

const ESCALATION_ORDER = ['FAST', 'SIMPLE', 'AGENTIC', 'HARD'] as const;
export const ESCALATION_THRESHOLD = 3;

/** Next lane up, or null when already at (or above) HARD. */
export function laneUp(lane: string): string | null {
  const i = ESCALATION_ORDER.indexOf(lane as (typeof ESCALATION_ORDER)[number]);
  if (i === -1) return null; // unknown lanes (custom) don't escalate
  return ESCALATION_ORDER[i + 1] ?? null;
}

/** Does the newest user turn carry a failed tool_result? */
export function lastTurnHadToolError(body: AnthropicRequest): boolean {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return false;
    return m.content.some((b) => b.type === 'tool_result' && b.is_error === true);
  }
  return false;
}

export const HARD_EXHAUSTED_NOTICE =
  'Free lanes are exhausted for this task — the HARD chain has no model left to try. ' +
  'Consider switching to native Claude (`claude`) for this one, or check `kompass status` ' +
  'for provider quota/cooldown state.';

/** Anthropic-format synthetic assistant reply (non-streaming). */
export function syntheticNotice(model: string): Record<string, unknown> {
  return {
    id: `msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: HARD_EXHAUSTED_NOTICE }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** Same notice as a well-formed Anthropic SSE stream. */
export function syntheticNoticeStream(model: string): string {
  const msg = syntheticNotice(model);
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', {
      type: 'message_start',
      message: { ...msg, content: [], stop_reason: null },
    }) +
    ev('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    ev('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: HARD_EXHAUSTED_NOTICE },
    }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    }) +
    ev('message_stop', { type: 'message_stop' })
  );
}
