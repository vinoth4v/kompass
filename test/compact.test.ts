// Server-side context compaction (src/worker/compact.ts). The hard constraint
// is structural: providers reject a conversation whose tool_use/tool_result
// pairing is broken, so compaction may only SHORTEN content — never remove a
// message or a block, never touch an id.
import { describe, expect, it } from 'vitest';
import { COMPACTION_DEFAULTS, compactRequest } from '../src/worker/compact';
import type { AnthropicRequest } from '../src/adapters/types';

const cfg = { ...COMPACTION_DEFAULTS, trigger_tokens: 100, keep_recent: 2, block_chars: 50 };

/** A realistic coding session: alternating tool_use / tool_result with big dumps. */
function session(turns: number): AnthropicRequest {
  const messages: AnthropicRequest['messages'] = [
    { role: 'user', content: 'Build module 1 of the ledger terminal.' },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `step ${i}` },
        { type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { file: `f${i}.ts` } },
      ],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'X'.repeat(5_000) }],
    });
  }
  return { model: 'claude-sonnet-4-5', max_tokens: 64, messages };
}

describe('server-side compaction', () => {
  it('shrinks old tool results without breaking tool_use/tool_result pairing', () => {
    const body = session(6);
    const before = Math.ceil(JSON.stringify(body.messages).length / 4);
    const r = compactRequest(body, before, cfg);

    expect(r.truncated).toBeGreaterThan(0);
    expect(r.after).toBeLessThan(r.before);

    // Structure is byte-for-byte identical in shape: same count, same roles,
    // same block types, same ids. Only string LENGTHS changed.
    expect(r.body.messages).toHaveLength(body.messages.length);
    const ids = (m: AnthropicRequest) =>
      m.messages.flatMap((msg) =>
        typeof msg.content === 'string'
          ? []
          : msg.content.map((b) =>
              b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : b.type,
            ),
      );
    expect(ids(r.body)).toEqual(ids(body));
    expect(r.body.messages.map((m) => m.role)).toEqual(body.messages.map((m) => m.role));
  });

  it('leaves the most recent turns and the original instruction verbatim', () => {
    const body = session(6);
    const r = compactRequest(body, 999_999, cfg);
    const n = body.messages.length;
    // keep_recent untouched…
    for (let i = n - cfg.keep_recent; i < n; i++) {
      expect(r.body.messages[i]).toEqual(body.messages[i]);
    }
    // …and the first message is the task itself.
    expect(r.body.messages[0]).toEqual(body.messages[0]);
  });

  it('marks what it elided rather than silently dropping it', () => {
    const r = compactRequest(session(6), 999_999, cfg);
    const text = JSON.stringify(r.body.messages);
    expect(text).toContain('kompass compacted');
  });

  it('is a no-op below the trigger, returning the identical object', () => {
    const body = session(1);
    const r = compactRequest(body, 10, cfg);
    expect(r.body).toBe(body); // identity — keeps the payload cache hitting
    expect(r.truncated).toBe(0);
  });

  it('never touches tool_use input (it is what the tool_result answers)', () => {
    const body = session(6);
    const r = compactRequest(body, 999_999, cfg);
    const inputs = (m: AnthropicRequest) =>
      m.messages.flatMap((msg) =>
        typeof msg.content === 'string'
          ? []
          : msg.content.filter((b) => b.type === 'tool_use').map((b) => JSON.stringify(b)),
      );
    expect(inputs(r.body)).toEqual(inputs(body));
  });

  it('handles array-form tool_result content', () => {
    const body: AnthropicRequest = {
      model: 'm',
      max_tokens: 8,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'Y'.repeat(9_000) }],
            },
          ],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
      ],
    };
    const r = compactRequest(body, 999_999, { ...cfg, keep_recent: 2 });
    expect(r.truncated).toBe(1);
    const block = (r.body.messages[2]!.content as Array<{ content: Array<{ text: string }> }>)[0]!;
    expect(block.content[0]!.text.length).toBeLessThan(9_000);
  });
});
