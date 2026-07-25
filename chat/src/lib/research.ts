// Research mode: a client-driven Anthropic tool-use loop against Kompass.
// The model turns go straight to the user's own Kompass Worker (cross-origin
// fetch, bearer in the Authorization header); the two tools it can call are
// executed by this app's own Vercel serverless routes (/api/tools/*), since a
// browser fetch to duckduckgo.com or an arbitrary site would hit CORS. No
// bash/filesystem tools here — that's what the local `kompass ui` is for.
import {
  sendMessage,
  type AnthropicMessageWire,
  type AnthropicTextBlockWire,
  type AnthropicToolResultBlockWire,
  type AnthropicToolUseBlockWire,
} from './kompassClient';
import type { KompassSettings } from './types';
import { TOOLS, executeTool } from './tools';

/**
 * Asked for in the same call rather than a second request: an extra round trip
 * per turn against free models costs a lane hop and several seconds, for three
 * short strings. Parsed out and stripped before display — a model that ignores
 * the format simply yields no chips, which is a fine failure mode.
 */
const FOLLOWUP_INSTRUCTION =
  'After your answer, add a final line in exactly this form, with two or three short ' +
  'questions the user would plausibly want to ask next, separated by " | ":\n' +
  'FOLLOWUPS: question one | question two | question three\n' +
  'Make them specific to what you just said, not generic. Omit the line entirely if no ' +
  'follow-up would genuinely help.';

/** Pull the FOLLOWUPS line out of a reply and return the cleaned text. */
export function extractFollowups(text: string): { text: string; followups?: string[] } {
  const m = /^[ \t]*FOLLOWUPS:[ \t]*(.+)$/im.exec(text);
  if (!m) return { text };
  const followups = (m[1] ?? '')
    .split('|')
    .map((q) => q.trim().replace(/^[-*\d.\s]+/, ''))
    .filter((q) => q.length > 3 && q.length < 160)
    .slice(0, 3);
  const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trimEnd();
  return { text: cleaned, followups: followups.length ? followups : undefined };
}

const RESEARCH_SYSTEM_PROMPT =
  'You are a careful research assistant. For exact current facts (weather, FX rates, stock and ' +
  'crypto prices, live scores, World Bank indicators) call get_data; for recent events call ' +
  'get_news — both return authoritative values rather than pages to interpret. ' +
  'Otherwise use the web_search tool to find relevant, ' +
  'current sources, then web_fetch 2-4 of the most promising results to read their ' +
  'full content before answering. Synthesize a clear, well-organized answer in ' +
  'markdown. Be explicit about uncertainty if sources are thin or conflicting — ' +
  'never fabricate facts or sources.\n\n' +
  FOLLOWUP_INSTRUCTION;

const MAX_ITERATIONS = 6;

export interface ResearchResult {
  text: string;
  /** Suggested next questions, stripped out of the reply text. */
  followups?: string[];
  sources: { title: string; url: string }[];
  usage: { input: number; output: number };
  servedBy: string | null;
  lane: string | null;
}

interface SearchResultJson {
  results?: { title: string; url: string; snippet: string }[];
  error?: string;
}
interface FetchResultJson {
  text?: string;
  error?: string;
}

export async function runResearch(
  settings: KompassSettings,
  lane: string,
  question: string,
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const history: AnthropicMessageWire[] = [{ role: 'user', content: question }];
  const sources: { title: string; url: string }[] = [];
  const seenUrls = new Set<string>();
  let totalIn = 0;
  let totalOut = 0;
  let servedBy: string | null = null;
  let servedLane: string | null = null;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const {
      response,
      servedBy: sb,
      lane: ln,
    } = await sendMessage(
      settings,
      {
        model: lane,
        max_tokens: 4096,
        system: RESEARCH_SYSTEM_PROMPT,
        messages: history,
        tools: TOOLS,
      },
      signal,
    );
    servedBy = sb;
    servedLane = ln;
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlockWire => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      const text = response.content
        .filter((b): b is AnthropicTextBlockWire => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n');
      return {
        text: text || '(no answer)',
        sources,
        usage: { input: totalIn, output: totalOut },
        servedBy,
        lane: servedLane,
      };
    }

    history.push({ role: 'assistant', content: response.content });
    const toolResults: AnthropicToolResultBlockWire[] = [];
    for (const call of toolUses) {
      toolResults.push(await executeTool(call, sources, seenUrls, {}, signal));
    }
    history.push({ role: 'user', content: toolResults });
  }

  return {
    text: 'Research took too many steps — here is what was gathered before stopping.',
    sources,
    usage: { input: totalIn, output: totalOut },
    servedBy,
    lane: servedLane,
  };
}

const CHAT_SYSTEM_PROMPT =
  'You are Kompass AI, a helpful assistant with access to web search.\n\n' +
  'For exact current facts — weather, currency rates, stock or crypto prices, live scores, ' +
  'macro indicators — call get_data, and for anything recent call get_news. Those return the ' +
  'fact itself rather than a page to interpret, so they are both faster and harder to get ' +
  'wrong than searching.\n\n' +
  'Use web_search (and then web_fetch on the most promising results) whenever the answer ' +
  'depends on facts you cannot be confident about from memory: current events, releases, ' +
  'versions, prices, people, "latest"/"best" questions, anything dated, or anything where being ' +
  'out of date would mislead. When you do, cite what you read.\n\n' +
  'Do NOT search for things you already know or that do not depend on current facts — writing ' +
  'code, explaining a concept, editing text, reasoning about something the user gave you. ' +
  "Searching those wastes the user's time.\n\n" +
  'If a search returns nothing useful, say so rather than filling the gap from memory and ' +
  'presenting it as current.\n\n' +
  FOLLOWUP_INSTRUCTION;

const CHAT_MAX_ITERATIONS = 4;

/**
 * Chat with optional web access. Same tools and same ground-truth citation rule
 * as research mode — a source is recorded only when a fetch actually succeeds —
 * but the model decides whether to use them at all, so ordinary conversation
 * costs exactly one request as before.
 */
export async function runChatWithTools(
  settings: KompassSettings,
  lane: string,
  history: AnthropicMessageWire[],
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const messages = [...history];
  const sources: { title: string; url: string }[] = [];
  const seenUrls = new Set<string>();
  let totalIn = 0;
  let totalOut = 0;
  let servedBy: string | null = null;
  let servedLane: string | null = null;

  for (let iter = 0; iter < CHAT_MAX_ITERATIONS; iter++) {
    const lastStep = iter === CHAT_MAX_ITERATIONS - 1;
    const {
      response,
      servedBy: sb,
      lane: ln,
    } = await sendMessage(
      settings,
      {
        model: lane,
        max_tokens: 4096,
        system: CHAT_SYSTEM_PROMPT,
        messages,
        // Withhold tools on the final step so the turn always ends in an answer
        // rather than an unfinished tool call.
        ...(lastStep ? {} : { tools: TOOLS }),
      },
      signal,
    );
    servedBy = sb;
    servedLane = ln;
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlockWire => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      const raw = response.content
        .filter((b): b is AnthropicTextBlockWire => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n');
      const { text, followups } = extractFollowups(raw);
      return {
        text: text || '(empty response)',
        followups,
        sources,
        usage: { input: totalIn, output: totalOut },
        servedBy,
        lane: servedLane,
      };
    }

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: AnthropicToolResultBlockWire[] = [];
    for (const call of toolUses) {
      toolResults.push(await executeTool(call, sources, seenUrls, {}, signal));
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: '(no answer)',
    sources,
    usage: { input: totalIn, output: totalOut },
    servedBy,
    lane: servedLane,
  };
}
