// House Voice. The point of the layer is that output shape stops depending on
// which model answered, so the tests assert shape-independence and the safety
// rails around it — not that a particular string got prepended.
import { describe, expect, it } from 'vitest';
import {
  VoiceSanitizer,
  appliesToRequest,
  compileStrip,
  composeVoice,
  sanitizeText,
  voiceConfig,
} from '../src/worker/voice';
import type { RouterConfig, VoiceConfig } from '../src/worker/config';
import type { AnthropicRequest } from '../src/adapters/types';

const VOICE: VoiceConfig = {
  enabled: true,
  system: 'HOUSE RULES.',
  verbosity: {
    TERSE: { instruction: 'One to three sentences.', max_tokens: 400 },
    NORMAL: { instruction: 'A few paragraphs.', max_tokens: 1200 },
    DEEP: { instruction: 'Thorough.', max_tokens: 4000 },
  },
  strip: {
    blocks: ['<think>', '<reasoning>'],
    lines: ['^\\s*(Thought|Reasoning)\\s*:\\s*'],
    openers: [
      '^\\s*(Great|Excellent)\\s+(question|point)[!.]?\\s*',
      '^\\s*(Certainly|Of course)[!,.]?\\s*',
      '^\\s*As an? (AI|language model)\\b[^,]*,\\s*',
    ],
  },
  apply_to: { header: 'x-kompass-surface', value: 'chat', skip_when_tools: true },
};

const cfg = (v?: VoiceConfig): RouterConfig =>
  ({
    version: 'v1',
    voice: v,
    providers: {},
    lanes: {},
    default_lane: 'AGENTIC',
    allow_paid: false,
  }) as unknown as RouterConfig;

const body = (over: Partial<AnthropicRequest> = {}): AnthropicRequest => ({
  model: 'kompass',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

describe('voice: when it applies', () => {
  it('is off entirely when disabled or absent', () => {
    expect(voiceConfig(cfg(undefined))).toBeNull();
    expect(voiceConfig(cfg({ ...VOICE, enabled: false }))).toBeNull();
  });

  it('applies to the chat surface', () => {
    expect(appliesToRequest(VOICE, body(), 'chat')).toBe(true);
  });

  it('does NOT apply to a coding client', () => {
    // Claude Code/Cursor send their own system prompts and depend on raw model
    // behaviour; imposing a three-sentence contract would break real work.
    expect(appliesToRequest(VOICE, body(), undefined)).toBe(false);
    expect(appliesToRequest(VOICE, body(), 'cli')).toBe(false);
  });

  it('never applies to a tool-carrying turn, whatever the header says', () => {
    const withTools = body({
      tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }],
    });
    expect(appliesToRequest(VOICE, withTools, 'chat')).toBe(false);
  });
});

describe('voice: composition', () => {
  it('prepends the house block and keeps the caller system prompt after it', () => {
    const out = composeVoice(VOICE, body({ system: 'CALLER TASK.' }), 'TERSE');
    const sys = out.body.system as unknown as string;
    expect(sys.indexOf('HOUSE RULES.')).toBeLessThan(sys.indexOf('CALLER TASK.'));
    expect(sys).toContain('One to three sentences.');
  });

  it('treats max_tokens as a ceiling, never a floor', () => {
    // Raising a caller's explicit limit would be the voice layer overriding an
    // explicit request rather than shaping output.
    expect(composeVoice(VOICE, body({ max_tokens: 4096 }), 'TERSE').maxTokens).toBe(400);
    expect(composeVoice(VOICE, body({ max_tokens: 120 }), 'DEEP').maxTokens).toBe(120);
  });

  it('gives the same ceiling regardless of which model will answer', () => {
    // The whole objective: length is a function of the ASK, not the backend.
    const a = composeVoice(VOICE, body(), 'TERSE').maxTokens;
    const b = composeVoice(VOICE, body(), 'TERSE').maxTokens;
    expect(a).toBe(b);
    expect(composeVoice(VOICE, body(), 'DEEP').maxTokens).toBeGreaterThan(a);
  });
});

describe('voice: artifact stripping', () => {
  const strip = compileStrip(cfg(VOICE))!;

  it('removes reasoning blocks with their contents', () => {
    expect(sanitizeText(strip, '<think>secret plan</think>The answer.')).toBe('The answer.');
    expect(sanitizeText(strip, '<reasoning>x</reasoning>Answer')).toBe('Answer');
  });

  it('removes an UNTERMINATED reasoning block — models truncate mid-scratchpad', () => {
    expect(sanitizeText(strip, '<think>never closed and then nothing')).toBe('');
  });

  it('removes sycophantic and self-identifying openers', () => {
    expect(sanitizeText(strip, 'Great question! The answer is 4.')).toBe('The answer is 4.');
    expect(sanitizeText(strip, 'Certainly! Paris.')).toBe('Paris.');
    expect(sanitizeText(strip, 'As an AI language model, I cannot.')).toBe('I cannot.');
  });

  it('strips stacked openers, which models emit together', () => {
    expect(sanitizeText(strip, 'Great question! Certainly, the answer is 4.')).toBe(
      'the answer is 4.',
    );
  });

  it('leaves the same words alone mid-answer', () => {
    const text = 'The cause is caching. Of course, you can disable it.';
    expect(sanitizeText(strip, text)).toBe(text);
  });

  it('does not touch ordinary prose or code', () => {
    const code = 'Use this:\n\n```ts\nconst x = a < b ? a : b;\n```\n\nThat is all.';
    expect(sanitizeText(strip, code)).toBe(code);
  });
});

describe('voice: streaming sanitizer', () => {
  const strip = compileStrip(cfg(VOICE))!;

  it('strips an artifact split across chunk boundaries', () => {
    // The reason this holds back a tail instead of matching per chunk.
    const s = new VoiceSanitizer(strip);
    let out = '';
    for (const chunk of ['<thi', 'nk>hidden', ' reasoning</th', 'ink>Real answer.']) {
      out += s.push(chunk);
    }
    out += s.flush();
    expect(out).toBe('Real answer.');
  });

  it('emits progressively rather than buffering the whole response', () => {
    // A sanitizer that only produced output at flush() would have broken SSE,
    // which is exactly why the rejected "finisher model" approach was rejected.
    const s = new VoiceSanitizer(strip);
    const long = 'x'.repeat(500);
    const emitted = s.push(long);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.length).toBeLessThan(long.length);
  });

  it('reassembles to exactly the input when there is nothing to strip', () => {
    const s = new VoiceSanitizer(strip);
    const parts = ['Hello ', 'world, ', 'this is fine.'];
    let out = '';
    for (const p of parts) out += s.push(p);
    out += s.flush();
    expect(out).toBe(parts.join(''));
  });
});

describe('voice: artifacts observed live', () => {
  // Each of these was seen in a real screenshot, not imagined.
  const LIVE: VoiceConfig = {
    ...VOICE,
    strip: {
      blocks: ['<tool_call>', '<think>'],
      lines: [],
      openers: [
        "^\\s*(You\\s+(are|'re)\\s+(completely\\s+|absolutely\\s+)?right|I\\s+apologi[sz]e)\\b[^.]*\\.\\s*",
      ],
    },
  };
  const strip = compileStrip({ ...cfg(LIVE), version: 'live' } as never)!;

  it('removes a tool call the model emitted as PROSE instead of calling it', () => {
    // nemotron-3-super printed this straight into the user's answer.
    const leaked =
      '<tool_call> <function=get_news> <parameter=query> Tamil Nadu CM </parameter> </function> </tool_call>';
    expect(sanitizeText(strip, leaked).trim()).toBe('');
  });

  it('strips a capitulation opener', () => {
    // Told "that's wrong", the model apologised and invented a new wrong
    // answer. Stripping the grovel is cosmetic; the house prompt handles the
    // caving itself.
    const text =
      'You are completely right, and I apologize for the previous error. The answer is X.';
    expect(sanitizeText(strip, text)).toBe('The answer is X.');
  });
});
