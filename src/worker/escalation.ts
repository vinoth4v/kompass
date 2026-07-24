// M5 failure escalation (SPEC §4): ≥3 consecutive failed tool iterations on a lane
// → escalate one lane up; when HARD is exhausted, a synthetic assistant notice tells
// the user to switch back to native claude.
import type { AnthropicRequest, AnthropicResponse } from '../adapters/types';
import { messageToAnthropicSSE } from './router';

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
  'Free lanes are exhausted for this task — every model in every lane failed. ' +
  'Consider switching to native Claude (`claude`) for this one, or check `kompass status` ' +
  'for provider quota/cooldown state.';

/** Anthropic-format synthetic assistant reply (non-streaming). */
export function syntheticNotice(model: string): AnthropicResponse {
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
  return messageToAnthropicSSE(syntheticNotice(model));
}

/**
 * M6 (SPEC_V2 §6, edge cases): distinct from HARD_EXHAUSTED_NOTICE — every
 * chain entry tried was dropped by the fit filter itself (structurally too
 * large), not by quota/health. Names the largest window actually configured
 * so the developer knows whether trimming the request could even help.
 */
export function noFitNoticeText(largestConfiguredCtx: number | undefined): string {
  return largestConfiguredCtx !== undefined
    ? `This request is too large for every configured model — the largest available ` +
        `context window is ${largestConfiguredCtx.toLocaleString()} tokens. Trim the request, ` +
        'or switch to native Claude (`claude`) for this one.'
    : HARD_EXHAUSTED_NOTICE;
}

export function noFitNotice(
  model: string,
  largestConfiguredCtx: number | undefined,
): AnthropicResponse {
  return {
    ...syntheticNotice(model),
    content: [{ type: 'text', text: noFitNoticeText(largestConfiguredCtx) }],
  };
}

export function noFitNoticeStream(model: string, largestConfiguredCtx: number | undefined): string {
  return messageToAnthropicSSE(noFitNotice(model, largestConfiguredCtx));
}
