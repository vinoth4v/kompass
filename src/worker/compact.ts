// Server-side context compaction.
//
// This is NOT Claude Code's `/compact`. That one runs on the client: it asks a
// model to summarize the conversation and rewrites the session's own history,
// so the saving persists for every later turn. A gateway cannot trigger it —
// nothing in the Anthropic wire protocol carries "please compact", and by the
// time a request arrives its history is already assembled.
//
// What a gateway CAN do is shrink the request it forwards. In a coding session
// the bulk is not the conversation, it is tool results: file dumps, directory
// listings, test output, git diffs. Those are also the least useful part of an
// OLD turn — the model has already acted on them, and what matters now is the
// recent work. So compaction truncates the content of large blocks in older
// turns and leaves recent turns untouched.
//
// Structural safety is the hard constraint. Anthropic requires every tool_use
// to be answered by a matching tool_result, and providers reject a history
// where that pairing is broken ("Conversation must have at least one message",
// "messages: minimum number of items is 1", and worse — silently wrong
// answers). So this NEVER removes a message or a block: it only shortens the
// text inside one, leaving every id, pairing and role sequence identical.
import type { AnthropicContentBlock, AnthropicRequest } from '../adapters/types';
import type { RouterConfig } from './config';

export interface CompactionConfig {
  /** Compact only when the estimated input exceeds this. */
  trigger_tokens: number;
  /** Most recent messages left completely untouched. */
  keep_recent: number;
  /** Characters kept per truncated block (head + tail around the marker). */
  block_chars: number;
}

export const COMPACTION_DEFAULTS: CompactionConfig = {
  // Below this, nothing here is worth the risk: requests this size are not what
  // pins isolate memory and every lane can hold them.
  trigger_tokens: 60_000,
  // Two to three full turns of back-and-forth, kept verbatim.
  keep_recent: 6,
  // Enough to keep a file's shape, a stack trace's head, or a diff's summary.
  block_chars: 2_000,
};

export interface CompactionResult {
  body: AnthropicRequest;
  /** Estimated tokens before/after, for logging and the response header. */
  before: number;
  after: number;
  /** Number of blocks whose content was shortened. */
  truncated: number;
}

export function compactionConfig(cfg: RouterConfig): CompactionConfig | null {
  const c = cfg.compaction;
  if (!c || c.enabled === false) return null;
  return {
    trigger_tokens: c.trigger_tokens ?? COMPACTION_DEFAULTS.trigger_tokens,
    keep_recent: c.keep_recent ?? COMPACTION_DEFAULTS.keep_recent,
    block_chars: c.block_chars ?? COMPACTION_DEFAULTS.block_chars,
  };
}

/** Keep the head and tail of a long string, with an explicit marker between —
 *  the model is TOLD content was elided rather than being handed a silent lie. */
function shorten(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.ceil(budget * 0.7);
  const tail = budget - head;
  const removed = text.length - budget;
  return (
    text.slice(0, head) +
    `\n\n… [kompass compacted ${removed.toLocaleString()} characters of an earlier tool result] …\n\n` +
    (tail > 0 ? text.slice(-tail) : '')
  );
}

function compactBlock(block: AnthropicContentBlock, budget: number, count: { n: number }) {
  // tool_use is deliberately untouched: its `input` is what the matching
  // tool_result answers, and its id is the pairing key.
  if (block.type === 'text') {
    if (block.text.length > budget) {
      count.n++;
      return { ...block, text: shorten(block.text, budget) };
    }
    return block;
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      if (block.content.length > budget) {
        count.n++;
        return { ...block, content: shorten(block.content, budget) };
      }
      return block;
    }
    if (Array.isArray(block.content)) {
      const content = block.content.map((b) =>
        b.type === 'text' && b.text.length > budget
          ? (count.n++, { ...b, text: shorten(b.text, budget) })
          : b,
      );
      return { ...block, content };
    }
  }
  // image/document/thinking: left alone. Images cannot be meaningfully
  // truncated, and a mangled base64 payload is worse than a large one.
  return block;
}

/**
 * Shrink an oversized request. Returns the ORIGINAL body object untouched when
 * nothing needed doing, so the payload cache (keyed by object identity) still
 * hits and small requests pay nothing for this feature existing.
 */
export function compactRequest(
  body: AnthropicRequest,
  estTokens: number,
  cfg: CompactionConfig,
): CompactionResult {
  if (estTokens <= cfg.trigger_tokens || body.messages.length <= cfg.keep_recent) {
    return { body, before: estTokens, after: estTokens, truncated: 0 };
  }

  const cutoff = body.messages.length - cfg.keep_recent;
  const count = { n: 0 };
  const messages = body.messages.map((m, i) => {
    // Recent turns verbatim, and the very first message too: in a coding
    // session that is the original instruction the whole task hangs on.
    if (i >= cutoff || i === 0) return m;
    if (typeof m.content === 'string') {
      if (m.content.length <= cfg.block_chars) return m;
      count.n++;
      return { ...m, content: shorten(m.content, cfg.block_chars) };
    }
    return { ...m, content: m.content.map((b) => compactBlock(b, cfg.block_chars, count)) };
  });

  if (count.n === 0) return { body, before: estTokens, after: estTokens, truncated: 0 };

  const compacted: AnthropicRequest = { ...body, messages };
  // Re-estimate off the serialized size, the same chars/4 rule used at ingress.
  const after = Math.ceil(JSON.stringify(messages).length / 4);
  return { body: compacted, before: estTokens, after, truncated: count.n };
}
