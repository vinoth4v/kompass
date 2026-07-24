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
  type AnthropicToolWire,
} from './kompassClient';
import type { KompassSettings } from './types';

const RESEARCH_SYSTEM_PROMPT =
  'You are a careful research assistant. Use the web_search tool to find relevant, ' +
  'current sources, then web_fetch 2-4 of the most promising results to read their ' +
  'full content before answering. Synthesize a clear, well-organized answer in ' +
  'markdown. Be explicit about uncertainty if sources are thin or conflicting — ' +
  'never fabricate facts or sources.';

const TOOLS: AnthropicToolWire[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns a list of results with title, url and snippet.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its main page text (scripts/styles stripped).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to fetch' } },
      required: ['url'],
    },
  },
];

const MAX_ITERATIONS = 6;

export interface ResearchResult {
  text: string;
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

async function runTool(
  call: AnthropicToolUseBlockWire,
  sources: { title: string; url: string }[],
  seenUrls: Set<string>,
  signal?: AbortSignal,
): Promise<AnthropicToolResultBlockWire> {
  if (call.name === 'web_search') {
    const query = String(call.input.query ?? '');
    try {
      const res = await fetch('/api/tools/web_search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      });
      const json = (await res.json()) as SearchResultJson;
      if (!res.ok || !json.results) {
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: `search failed: ${json.error ?? res.status}`,
          is_error: true,
        };
      }
      for (const r of json.results) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          sources.push({ title: r.title, url: r.url });
        }
      }
      const summary = json.results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      return { type: 'tool_result', tool_use_id: call.id, content: summary || 'no results' };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `search failed: ${String(e)}`,
        is_error: true,
      };
    }
  }
  if (call.name === 'web_fetch') {
    const url = String(call.input.url ?? '');
    try {
      const res = await fetch('/api/tools/web_fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal,
      });
      const json = (await res.json()) as FetchResultJson;
      if (!res.ok) {
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: `fetch failed: ${json.error ?? res.status}`,
          is_error: true,
        };
      }
      return { type: 'tool_result', tool_use_id: call.id, content: json.text ?? '' };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `fetch failed: ${String(e)}`,
        is_error: true,
      };
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: `unknown tool "${call.name}"`,
    is_error: true,
  };
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
    const { response, servedBy: sb, lane: ln } = await sendMessage(
      settings,
      { model: lane, max_tokens: 4096, system: RESEARCH_SYSTEM_PROMPT, messages: history, tools: TOOLS },
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
      toolResults.push(await runTool(call, sources, seenUrls, signal));
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
