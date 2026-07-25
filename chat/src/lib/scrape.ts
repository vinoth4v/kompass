// Shared HTML-scraping helpers for the research-mode tool routes. Ported
// from the local `kompass ui`'s src/ui/tools.ts webSearchTool/webFetchTool —
// same DuckDuckGo HTML-endpoint scrape (no API key), same regex parse. Runs
// server-side here (a Vercel serverless function) rather than a local Node
// process, since a browser fetch to duckduckgo.com would hit CORS.
const MAX_OUTPUT = 20_000;

export function clip(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]` : s;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;/g, ' ');
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search runs a FALLBACK CHAIN, the same idea as the gateway's model chains and
 * for the same reason: any single free backend will refuse us sooner or later.
 *
 * DuckDuckGo's HTML endpoint returns 403 to Vercel's datacenter IPs — verified
 * live against the deployed function while every agent in the AI Council was
 * answering "I'm currently unable to access search results" from memory. A
 * browser User-Agent matters too: the previous one announced itself as
 * "KompassAI/1.0", which is trivially blockable.
 *
 * Each backend is tried in turn; an empty result set counts as a failure and
 * falls through, because a 200 carrying a challenge page is the common shape of
 * being blocked. The winning backend's name is returned so callers (and the
 * /api/tools/web_search route) can report what actually served the query.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_HEADERS = {
  'user-agent': BROWSER_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

/** DuckDuckGo HTML — best quality when it lets us through. */
async function ddgHtml(query: string): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { ...SEARCH_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1] ?? ''));
  const out: SearchResult[] = [];
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    if (out.length >= 8) break;
    let url = m[1] ?? '';
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: stripTags(m[2] ?? ''), url, snippet: snippets[i] ?? '' });
    i++;
  }
  return out;
}

/** DuckDuckGo Lite — a different frontend, sometimes allowed when the above is not. */
async function ddgLite(query: string): Promise<SearchResult[]> {
  const res = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: { ...SEARCH_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(linkRe)) {
    if (out.length >= 8) break;
    let url = m[1] ?? '';
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: stripTags(m[2] ?? ''), url, snippet: '' });
  }
  return out;
}

/** Mojeek — an independent index that tolerates plain HTTP clients. */
async function mojeek(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
    headers: SEARCH_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  // Mojeek results are <a class="ob"> (title link) inside <li>, with the
  // description in <p class="s">.
  const blockRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  for (const b of html.matchAll(blockRe)) {
    if (out.length >= 8) break;
    const block = b[1] ?? '';
    const link = /<a[^>]*class="[^"]*ob[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = link[1] ?? '';
    if (!/^https?:\/\//.test(url)) continue;
    const desc = /<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({ title: stripTags(link[2] ?? ''), url, snippet: stripTags(desc?.[1] ?? '') });
  }
  return out;
}

/**
 * Wikipedia — the guaranteed floor. Narrow, but it is a real API with no key,
 * no blocking and no scraping, so the council is never left with nothing at all.
 */
async function wikipedia(query: string): Promise<SearchResult[]> {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=' +
    encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { 'user-agent': 'KompassAI/1.0 (https://github.com/vinoth4v/kompass)' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    query?: { search?: { title: string; snippet: string }[] };
  };
  return (json.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: stripTags(r.snippet),
  }));
}

const BACKENDS: { name: string; run: (q: string) => Promise<SearchResult[]> }[] = [
  { name: 'duckduckgo', run: ddgHtml },
  { name: 'duckduckgo-lite', run: ddgLite },
  { name: 'mojeek', run: mojeek },
  { name: 'wikipedia', run: wikipedia },
];

export interface SearchOutcome {
  results: SearchResult[];
  backend: string;
  /** Backends tried and why they were rejected — surfaced for debugging. */
  tried: string[];
}

export async function webSearchDetailed(query: string): Promise<SearchOutcome> {
  const tried: string[] = [];
  for (const b of BACKENDS) {
    try {
      const results = await b.run(query);
      if (results.length > 0) return { results, backend: b.name, tried };
      // A 200 with no parseable results is the usual shape of a block page.
      tried.push(`${b.name}: 0 results`);
    } catch (e) {
      tried.push(`${b.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results: [], backend: 'none', tried };
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  const { results, tried } = await webSearchDetailed(query);
  if (results.length === 0) throw new Error(`all search backends failed — ${tried.join('; ')}`);
  return results;
}

export async function webFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) KompassAI/1.0' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
  return clip(text);
}
