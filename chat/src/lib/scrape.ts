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

export async function webSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) KompassAI/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  const html = await res.text();
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) =>
    decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).trim(),
  );
  const results: SearchResult[] = [];
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    if (results.length >= 8) break;
    let url = m[1] ?? '';
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    const title = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    results.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
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
