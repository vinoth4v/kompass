// The one tool surface shared by Chat, Research and the AI Council.
//
// Previously each mode carried its own copy of the tool definitions and its own
// executor, so a capability added to research silently did not exist in chat or
// the council. One definition, one executor, three modes.
//
// Tool COUNT is kept deliberately small. These are free models with modest
// tool-calling ability; every extra tool measurably degrades their choice of
// which to call. So the structured sources are multiplexed behind one
// `get_data` tool with a `kind` argument rather than exposed as six tools.
//
// Citation rule, unchanged and load-bearing: a source is recorded only when a
// fetch or a data lookup actually SUCCEEDS. Nothing is ever cited because a
// model said it read it.
import type {
  AnthropicToolResultBlockWire,
  AnthropicToolUseBlockWire,
  AnthropicToolWire,
} from './kompassClient';

export interface Source {
  title: string;
  url: string;
}

export const TOOLS: AnthropicToolWire[] = [
  {
    name: 'web_search',
    description:
      'Search the web. Returns a list of results with title, url and snippet. Use for general ' +
      'questions, background, and finding pages worth reading.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its main page text. Use this to actually READ a promising search ' +
      'result — a snippet alone is not enough to answer on.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'get_news',
    description:
      'Current news headlines with publication dates and outlets (Google News). Use for anything ' +
      'recent, breaking, or where being out of date would mislead — this is far more reliable ' +
      'than recalling events from memory.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'News topic, person, company or event' } },
      required: ['query'],
    },
  },
  {
    name: 'get_data',
    description:
      'Look up an exact, current fact from an authoritative source. Prefer this over web_search ' +
      'whenever it applies — it returns the number itself rather than a page to interpret. ' +
      'kind=weather (forecast for a place), sports (live scores/fixtures for a league such as ' +
      'NBA/NFL/premier/bundesliga, or a team profile), fx (currency rate, e.g. "EUR to USD"), ' +
      'crypto (coin price by CoinGecko id, e.g. "bitcoin"), stock (quote by ticker, e.g. "AAPL"), ' +
      'macro (World Bank indicator, e.g. "DE NY.GDP.MKTP.CD").',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['weather', 'sports', 'fx', 'crypto', 'stock', 'macro'],
          description: 'Which structured source to query',
        },
        query: { type: 'string', description: 'Place, league, team, currency pair, coin or ticker' },
      },
      required: ['kind', 'query'],
    },
  },
];

/** Hooks so the Council can drive its live agent cards from the same executor. */
export interface ToolHooks {
  onSearch?: (query: string) => void;
  onFetch?: (url: string) => void;
  onData?: (kind: string, query: string) => void;
  /** Fired only on a SUCCESSFUL read — the moment a citation becomes honest. */
  onRead?: () => void;
}

interface SearchResultJson {
  results?: { title: string; url: string; snippet: string }[];
  backend?: string;
  error?: string;
}
interface FetchResultJson {
  text?: string;
  error?: string;
}
interface DataResultJson {
  text?: string;
  source?: string;
  error?: string;
}

const err = (call: AnthropicToolUseBlockWire, msg: string): AnthropicToolResultBlockWire => ({
  type: 'tool_result',
  tool_use_id: call.id,
  content: msg,
  is_error: true,
});

export async function executeTool(
  call: AnthropicToolUseBlockWire,
  sources: Source[],
  seenUrls: Set<string>,
  hooks: ToolHooks = {},
  signal?: AbortSignal,
): Promise<AnthropicToolResultBlockWire> {
  try {
    if (call.name === 'web_search') {
      const query = String(call.input.query ?? '');
      hooks.onSearch?.(query);
      const res = await fetch('/api/tools/web_search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      });
      const json = (await res.json()) as SearchResultJson;
      if (!res.ok || !json.results) return err(call, `search failed: ${json.error ?? res.status}`);
      const summary = json.results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: summary || 'no results',
      };
    }

    if (call.name === 'web_fetch') {
      const url = String(call.input.url ?? '');
      hooks.onFetch?.(url);
      const res = await fetch('/api/tools/web_fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal,
      });
      const json = (await res.json()) as FetchResultJson;
      if (!res.ok) return err(call, `fetch failed: ${json.error ?? res.status}`);
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        sources.push({ title: url.replace(/^https?:\/\//, '').slice(0, 80), url });
        hooks.onRead?.();
      }
      return { type: 'tool_result', tool_use_id: call.id, content: json.text ?? '' };
    }

    if (call.name === 'get_news' || call.name === 'get_data') {
      const kind = call.name === 'get_news' ? 'news' : String(call.input.kind ?? '');
      const query = String(call.input.query ?? '');
      hooks.onData?.(kind, query);
      const res = await fetch('/api/tools/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, query }),
        signal,
      });
      const json = (await res.json()) as DataResultJson;
      if (!res.ok || !json.text) return err(call, `${kind} lookup failed: ${json.error ?? res.status}`);
      // A successful structured lookup is a real, citable source — the same
      // standard applied to a fetched page.
      const url = `kompass:${kind}/${encodeURIComponent(query)}`;
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        sources.push({ title: `${json.source ?? kind} — ${query}`, url });
        hooks.onRead?.();
      }
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `${json.text}\n\n(source: ${json.source ?? kind})`,
      };
    }

    return err(call, `unknown tool "${call.name}"`);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return err(call, `${call.name} failed: ${String(e).slice(0, 200)}`);
  }
}
