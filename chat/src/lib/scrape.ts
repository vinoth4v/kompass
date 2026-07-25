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

type Backend = { name: string; run: (q: string) => Promise<SearchResult[]> };

// ── Keyed general-web providers ──────────────────────────────────────────────
// Free tiers, but they need a signup. Keys live in Vercel environment variables
// (server-side only — they never reach the browser, same trust split as the
// gateway bearer). A provider with no key configured is skipped silently.

async function brave(query: string): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('no key');
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`,
    {
      headers: { accept: 'application/json', 'x-subscription-token': key },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (json.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: stripTags(r.title ?? r.url ?? ''),
      url: r.url!,
      snippet: stripTags(r.description ?? ''),
    }));
}

async function tavily(query: string): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('no key');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 8, search_depth: 'basic' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: (r.content ?? '').slice(0, 300) }));
}

async function serper(query: string): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('no key');
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ q: query, num: 8 }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    organic?: { title?: string; link?: string; snippet?: string }[];
  };
  return (json.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({ title: r.title ?? r.link!, url: r.link!, snippet: r.snippet ?? '' }));
}

async function exa(query: string): Promise<SearchResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error('no key');
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, numResults: 8, type: 'auto' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: (r.text ?? '').slice(0, 300) }));
}

// ── Keyless specialist sources ───────────────────────────────────────────────
// Real APIs rather than scrapes, so a datacenter IP cannot be blocked the way
// DuckDuckGo and Mojeek block us. Individually narrow; aggregated they cover a
// lot of what a developer actually asks about, and crucially they are CURRENT —
// which Wikipedia alone is not.

/** Hacker News via Algolia. Excellent for tooling, launches and current opinion. */
async function hackernews(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=6&query=${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    hits?: { title?: string; url?: string; objectID?: string; points?: number }[];
  };
  return (json.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title!,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `Hacker News${h.points ? ` · ${h.points} points` : ''}`,
    }));
}

/** GitHub repositories — what tooling actually exists and is maintained. */
async function github(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.github.com/search/repositories?per_page=5&sort=stars&q=${encodeURIComponent(query)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'KompassAI/1.0 (https://github.com/vinoth4v/kompass)',
      },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    items?: { full_name?: string; html_url?: string; description?: string; stargazers_count?: number }[];
  };
  return (json.items ?? [])
    .filter((r) => r.html_url)
    .map((r) => ({
      title: `${r.full_name} (${r.stargazers_count ?? 0}★)`,
      url: r.html_url!,
      snippet: r.description ?? '',
    }));
}

/** Stack Overflow — concrete problems and their accepted answers. */
async function stackexchange(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    'https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=5&site=stackoverflow&q=' +
      encodeURIComponent(query),
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    items?: { title?: string; link?: string; score?: number; is_answered?: boolean }[];
  };
  return (json.items ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      title: decodeEntities(r.title ?? r.link!),
      url: r.link!,
      snippet: `Stack Overflow · score ${r.score ?? 0}${r.is_answered ? ' · answered' : ''}`,
    }));
}

/** arXiv — primary research, for questions where papers are the real source. */
async function arxiv(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://export.arxiv.org/api/query?max_results=5&search_query=all:${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const out: SearchResult[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1] ?? '';
    const id = /<id>([^<]+)<\/id>/.exec(e)?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1];
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(e)?.[1];
    if (!id || !title) continue;
    out.push({
      title: stripTags(title).replace(/\s+/g, ' '),
      url: id.trim(),
      snippet: stripTags(summary ?? '').replace(/\s+/g, ' ').slice(0, 300),
    });
  }
  return out;
}

const KEYED: Backend[] = [
  { name: 'brave', run: brave },
  { name: 'tavily', run: tavily },
  { name: 'serper', run: serper },
  { name: 'exa', run: exa },
];

const KEYLESS_WEB: Backend[] = [
  { name: 'duckduckgo', run: ddgHtml },
  { name: 'duckduckgo-lite', run: ddgLite },
  { name: 'mojeek', run: mojeek },
];

const SPECIALIST: Backend[] = [
  { name: 'hackernews', run: hackernews },
  { name: 'github', run: github },
  { name: 'stackoverflow', run: stackexchange },
  { name: 'wikipedia', run: wikipedia },
  { name: 'arxiv', run: arxiv },
];

export interface SearchOutcome {
  results: SearchResult[];
  backend: string;
  /** Backends tried and why they were rejected — surfaced for debugging. */
  tried: string[];
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/**
 * Three tiers, in order:
 *
 *   1. A keyed general-web provider, if one is configured. Best coverage.
 *   2. A scraped general-web engine. Free, but all of them block datacenter IPs
 *      — kept because a self-hosted or local deployment is not blocked.
 *   3. The keyless specialist APIs, AGGREGATED rather than raced. Individually
 *      narrow; together they cover current tooling (HN, GitHub), concrete
 *      problems (Stack Overflow), background (Wikipedia) and research (arXiv).
 *      They run in parallel and their results are merged, because breadth is
 *      exactly what this tier lacks on its own.
 */
export async function webSearchDetailed(query: string): Promise<SearchOutcome> {
  const tried: string[] = [];

  for (const tier of [KEYED, KEYLESS_WEB]) {
    for (const b of tier) {
      try {
        const results = await b.run(query);
        if (results.length > 0) return { results, backend: b.name, tried };
        tried.push(`${b.name}: 0 results`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // "no key" is configuration, not failure — do not shout about it.
        tried.push(`${b.name}: ${msg}`);
      }
    }
  }

  const settled = await Promise.allSettled(SPECIALIST.map((b) => b.run(query)));
  const merged: SearchResult[] = [];
  const used: string[] = [];
  settled.forEach((r, i) => {
    const name = SPECIALIST[i]!.name;
    if (r.status === 'fulfilled' && r.value.length > 0) {
      used.push(name);
      merged.push(...r.value);
    } else {
      tried.push(`${name}: ${r.status === 'rejected' ? String(r.reason).slice(0, 60) : '0 results'}`);
    }
  });

  if (merged.length > 0) {
    // Interleave so one prolific source cannot crowd the others out of the top.
    const bySource = new Map<string, SearchResult[]>();
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.length > 0) bySource.set(SPECIALIST[i]!.name, r.value);
    });
    const interleaved: SearchResult[] = [];
    for (let i = 0; i < 6; i++) {
      for (const list of bySource.values()) if (list[i]) interleaved.push(list[i]!);
    }
    return { results: dedupe(interleaved).slice(0, 12), backend: used.join('+'), tried };
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
