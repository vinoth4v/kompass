// House Voice: one output shape regardless of which backend model answers.
//
// Kompass routes across ~10 providers, and each model has its own default
// verbosity, tone, formatting habits and artifact leakage. The effect is that
// response LENGTH is currently a function of which model answered. It has to
// become a function of what was asked.
//
// Two mechanisms, both cheap:
//
//   1. COMPOSE — a house system prompt plus a verbosity contract is prepended
//      before adapter translation. The verbosity tier comes from the dispatcher
//      verdict the classifier already returns, so there is no second classifier
//      call and no added latency.
//
//   2. SANITIZE — model artifacts (reasoning tags, self-identification,
//      sycophantic openers) are stripped from the stream as it passes through,
//      against a small tail buffer. Never by buffering the whole response:
//      streaming has to keep working.
//
// A second-pass "finisher" model that rewrites each answer was considered and
// rejected — it doubles latency, forces full-response buffering, burns
// dispatcher budget and mangles code blocks.
import type { AnthropicRequest, AnthropicTextBlock } from '../adapters/types';
import type { RouterConfig, Verbosity, VoiceConfig } from './config';

export function voiceConfig(cfg: RouterConfig): VoiceConfig | null {
  const v = cfg.voice;
  if (!v || v.enabled === false || !v.system) return null;
  return v;
}

/**
 * Does this request get the house voice?
 *
 * Coding clients (Claude Code, Cursor, Cline) send their own carefully built
 * system prompts and depend on raw model behaviour for tool-calling
 * conventions. Imposing a three-sentence contract on them would break real
 * work, so the voice is opt-in by surface — and a tool-carrying turn is treated
 * as agentic regardless of what the header says.
 */
export function appliesToRequest(
  v: VoiceConfig,
  body: AnthropicRequest,
  surfaceHeader: string | undefined,
): boolean {
  if (v.apply_to?.skip_when_tools !== false && body.tools?.length) return false;
  const want = v.apply_to?.value;
  if (!want) return true;
  return surfaceHeader?.trim().toLowerCase() === want.toLowerCase();
}

function systemToText(system: AnthropicRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

export interface ComposedVoice {
  body: AnthropicRequest;
  verbosity: Verbosity;
  /** Ceiling actually applied, for the response header and the trace. */
  maxTokens: number;
}

/**
 * Prepend the house prompt and the verbosity contract.
 *
 * The caller's own system prompt is kept and placed AFTER the house block: the
 * house voice sets shape, the caller sets task, and a caller instruction should
 * win where the two genuinely conflict.
 */
export function composeVoice(
  v: VoiceConfig,
  body: AnthropicRequest,
  verbosity: Verbosity,
): ComposedVoice {
  const contract = v.verbosity[verbosity] ?? v.verbosity.NORMAL;
  const houseBlock = [v.system.trim(), contract?.instruction?.trim()].filter(Boolean).join('\n\n');

  const existing = systemToText(body.system).trim();
  const merged = existing ? `${houseBlock}\n\n---\n\n${existing}` : houseBlock;

  // The contract is a CEILING, never a floor: a caller that asked for 200
  // tokens still gets 200. Raising someone's limit because the tier allows more
  // would be the voice layer overriding an explicit request.
  const ceiling = contract?.max_tokens;
  const maxTokens =
    ceiling === undefined ? body.max_tokens : Math.min(body.max_tokens || ceiling, ceiling);

  return {
    body: {
      ...body,
      system: merged as unknown as AnthropicTextBlock[] | string,
      max_tokens: maxTokens,
    },
    verbosity,
    maxTokens,
  };
}

/* ── Stream sanitizer ─────────────────────────────────────────────────────── */

export interface CompiledStrip {
  /** `<think> … </think>` — safe to apply on every chunk. */
  blocks: RegExp[];
  /**
   * `<think> …` with no closer. Applied ONLY at flush: mid-stream it would
   * match to end-of-buffer, eat the opening tag, and then leak the closing tag
   * as literal text once it arrived in a later chunk.
   */
  blocksOpen: RegExp[];
  /** Raw opening tags, used to hold back an in-progress block. */
  openTags: string[];
  lines: RegExp[];
  openers: RegExp[];
  maxTagLen: number;
}

let cachedVersion: string | undefined;
let cachedStrip: CompiledStrip | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiled once per config version — recompiling per request is wasted CPU. */
export type CompiledStripRules = CompiledStrip;

export function compileStrip(cfg: RouterConfig): CompiledStrip | null {
  if (cfg.version !== undefined && cfg.version === cachedVersion) return cachedStrip;
  const v = cfg.voice;
  const strip = v?.strip;
  let compiled: CompiledStrip | null = null;
  if (v && v.enabled !== false && strip) {
    const blocks: RegExp[] = [];
    const blocksOpen: RegExp[] = [];
    const openTags: string[] = [];
    let maxTagLen = 0;
    for (const open of strip.blocks ?? []) {
      const close = open.replace('<', '</');
      maxTagLen = Math.max(maxTagLen, open.length + close.length);
      openTags.push(open);
      try {
        blocks.push(new RegExp(`${escapeRe(open)}[\\s\\S]*?${escapeRe(close)}`, 'gi'));
        blocksOpen.push(new RegExp(`${escapeRe(open)}[\\s\\S]*$`, 'i'));
      } catch {
        /* a bad pattern must not disable the rest */
      }
    }
    const compile = (list: string[] | undefined, flags: string) =>
      (list ?? []).flatMap((p) => {
        try {
          return [new RegExp(p, flags)];
        } catch {
          console.log(`voice: invalid strip pattern skipped: ${p}`);
          return [];
        }
      });
    compiled = {
      blocks,
      blocksOpen,
      openTags,
      lines: compile(strip.lines, 'gim'),
      openers: compile(strip.openers, 'i'),
      maxTagLen: Math.max(maxTagLen, 24),
    };
  }
  cachedVersion = cfg.version;
  cachedStrip = compiled;
  return compiled;
}

/**
 * Incremental sanitizer over a text stream.
 *
 * Holds back only a short tail — long enough that an artifact spanning two
 * chunks is still matched, short enough that output stays live. Openers are
 * applied only while nothing has been emitted yet, because the same words are
 * usually legitimate mid-answer.
 */
export class VoiceSanitizer {
  private tail = '';
  private emitted = false;
  private readonly hold: number;

  /**
   * Nothing is emitted until this many characters have accumulated, so opener
   * patterns are tested against a real prefix rather than the first few bytes
   * of one. Small enough to be imperceptible, large enough to cover a stacked
   * "Great question! Certainly, …".
   */
  private static readonly HEAD_HOLD = 260;

  constructor(private readonly strip: CompiledStrip) {
    this.hold = Math.max(32, strip.maxTagLen);
  }

  /** Feed a chunk, get back what is safe to emit now. */
  push(chunk: string): string {
    let buf = this.applyBlocksAndLines(this.tail + chunk);

    // An opener with no closer yet: hold from the tag onward, or the block's
    // contents stream straight through while its closer is still in flight.
    const openAt = this.unclosedBlockIndex(buf);
    const safeLimit = openAt >= 0 ? openAt : Math.max(0, buf.length - this.hold);

    // Before anything has been emitted, keep a larger head back so openers are
    // matched against enough text to be recognisable.
    const limit = this.emitted
      ? safeLimit
      : Math.min(safeLimit, Math.max(0, buf.length - VoiceSanitizer.HEAD_HOLD));

    if (limit <= 0) {
      this.tail = buf;
      return '';
    }
    let out = buf.slice(0, limit);
    this.tail = buf.slice(limit);

    if (!this.emitted) {
      out = this.stripOpeners(out);
      if (out.trim()) this.emitted = true;
    }
    return out;
  }

  /** Flush whatever is held back — call once when the stream ends. */
  flush(): string {
    let out = this.applyBlocksAndLines(this.tail);
    // Only now is an unterminated block genuinely unterminated: the model
    // stopped mid-scratchpad rather than the closer being in the next chunk.
    for (const re of this.strip.blocksOpen) out = out.replace(re, '');
    this.tail = '';
    if (!this.emitted) out = this.stripOpeners(out);
    this.emitted = true;
    return out;
  }

  /** Index of an opening tag whose closer has not arrived yet, or -1. */
  private unclosedBlockIndex(buf: string): number {
    let earliest = -1;
    const lower = buf.toLowerCase();
    for (const open of this.strip.openTags) {
      const o = lower.lastIndexOf(open.toLowerCase());
      if (o === -1) continue;
      const close = open.replace('<', '</').toLowerCase();
      if (lower.indexOf(close, o) === -1 && (earliest === -1 || o < earliest)) earliest = o;
    }
    return earliest;
  }

  private applyBlocksAndLines(s: string): string {
    let out = s;
    for (const re of this.strip.blocks) out = out.replace(re, '');
    for (const re of this.strip.lines) out = out.replace(re, '');
    return out;
  }

  private stripOpeners(s: string): string {
    let out = s.replace(/^\s+/, '');
    // Applied repeatedly: models stack them ("Great question! Certainly, …").
    for (let i = 0; i < 4; i++) {
      const before = out;
      for (const re of this.strip.openers) out = out.replace(re, '');
      out = out.replace(/^\s+/, '');
      if (out === before) break;
    }
    return out;
  }
}

/** Whole-string convenience for the buffered (non-streaming) path. */
export function sanitizeText(strip: CompiledStrip, text: string): string {
  const s = new VoiceSanitizer(strip);
  return s.push(text) + s.flush();
}
