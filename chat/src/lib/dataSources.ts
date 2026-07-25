// Structured, keyless data sources — server-side (Vercel route) so datacenter
// blocking and CORS are both handled in one place.
//
// These are deliberately NOT part of the search chain. Search returns pages a
// model must read and interpret; these return facts. For "what is the weather in
// Berlin" or "EUR to USD", a scraped search result is strictly worse than the
// number itself: slower, longer, and an invitation to hallucinate. Precision is
// the whole point.
//
// Every source here was probed live before wiring. Anything that needed a key,
// or refused a datacenter IP, was dropped rather than shipped hopefully.

export interface DataResult {
  /** Compact factual text handed straight to the model. */
  text: string;
  /** Where it came from, for citation. */
  source: string;
}

const UA = 'KompassAI/1.0 (https://github.com/vinoth4v/kompass)';

function stripXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Google News RSS. Keyless, no quota, and the single best freshness source
 * available without a key — every item carries a publication date and outlet,
 * which is exactly what a model needs to avoid answering from stale training
 * data.
 */
export async function getNews(query: string): Promise<DataResult> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`google news HTTP ${res.status}`);
  const xml = await res.text();
  const items: string[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (items.length >= 10) break;
    const it = m[1] ?? '';
    const title = stripXml(/<title>([\s\S]*?)<\/title>/.exec(it)?.[1] ?? '');
    const link = stripXml(/<link>([\s\S]*?)<\/link>/.exec(it)?.[1] ?? '');
    const date = stripXml(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it)?.[1] ?? '');
    const src = stripXml(/<source[^>]*>([\s\S]*?)<\/source>/.exec(it)?.[1] ?? '');
    if (!title) continue;
    items.push(`- ${title}${src ? ` (${src})` : ''}${date ? ` — ${date}` : ''}\n  ${link}`);
  }
  if (items.length === 0) throw new Error('no news items');
  return {
    text: `Google News results for "${query}" (newest first):\n${items.join('\n')}`,
    source: 'Google News',
  };
}

/** Open-Meteo: free, keyless, no quota. Geocode the place name, then forecast. */
export async function getWeather(place: string): Promise<DataResult> {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(place)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) },
  );
  if (!geo.ok) throw new Error(`geocoding HTTP ${geo.status}`);
  const g = (await geo.json()) as {
    results?: { name: string; country?: string; latitude: number; longitude: number }[];
  };
  const loc = g.results?.[0];
  if (!loc) throw new Error(`no such place: ${place}`);

  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=3&timezone=auto',
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  const w = (await res.json()) as {
    current?: Record<string, number | string>;
    current_units?: Record<string, string>;
    daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_sum?: number[] };
  };
  const c = w.current ?? {};
  const u = w.current_units ?? {};
  const lines = [
    `Weather for ${loc.name}${loc.country ? `, ${loc.country}` : ''} (observed now):`,
    `- temperature: ${c.temperature_2m}${u.temperature_2m ?? '°C'} (feels like ${c.apparent_temperature}${u.apparent_temperature ?? '°C'})`,
    `- humidity: ${c.relative_humidity_2m}${u.relative_humidity_2m ?? '%'}`,
    `- precipitation: ${c.precipitation}${u.precipitation ?? 'mm'}`,
    `- wind: ${c.wind_speed_10m}${u.wind_speed_10m ?? 'km/h'}`,
  ];
  const d = w.daily;
  if (d?.time?.length) {
    lines.push('Forecast:');
    d.time.forEach((day, i) => {
      lines.push(
        `- ${day}: ${d.temperature_2m_min?.[i]}–${d.temperature_2m_max?.[i]}°C, precipitation ${d.precipitation_sum?.[i]}mm`,
      );
    });
  }
  return { text: lines.join('\n'), source: 'Open-Meteo' };
}

/** ESPN's public scoreboard feeds, plus TheSportsDB for team lookups. */
export async function getSports(query: string): Promise<DataResult> {
  const LEAGUES: Record<string, string> = {
    premier: 'soccer/eng.1',
    epl: 'soccer/eng.1',
    laliga: 'soccer/esp.1',
    bundesliga: 'soccer/ger.1',
    'serie a': 'soccer/ita.1',
    nba: 'basketball/nba',
    nfl: 'football/nfl',
    mlb: 'baseball/mlb',
    nhl: 'hockey/nhl',
  };
  const q = query.toLowerCase();
  const league = Object.keys(LEAGUES).find((k) => q.includes(k));

  if (league) {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league]}/scoreboard`,
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) throw new Error(`espn HTTP ${res.status}`);
    const j = (await res.json()) as {
      events?: { name?: string; date?: string; status?: { type?: { detail?: string } };
        competitions?: { competitors?: { team?: { displayName?: string }; score?: string }[] }[] }[];
    };
    const games = (j.events ?? []).slice(0, 10).map((e) => {
      const c = e.competitions?.[0]?.competitors ?? [];
      const score = c.map((x) => `${x.team?.displayName ?? '?'} ${x.score ?? ''}`).join(' vs ');
      return `- ${score || e.name} — ${e.status?.type?.detail ?? e.date ?? ''}`;
    });
    if (games.length === 0) throw new Error('no fixtures returned');
    return { text: `Scoreboard (${league}):\n${games.join('\n')}`, source: 'ESPN' };
  }

  // Team lookup fallback. "3" is TheSportsDB's documented public test key.
  const res = await fetch(
    `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`thesportsdb HTTP ${res.status}`);
  const j = (await res.json()) as {
    teams?: { strTeam?: string; strLeague?: string; intFormedYear?: string; strStadium?: string; strDescriptionEN?: string }[];
  };
  const t = j.teams?.[0];
  if (!t) throw new Error(`no team found for "${query}"`);
  return {
    text:
      `${t.strTeam} — ${t.strLeague ?? 'league unknown'}, formed ${t.intFormedYear ?? '?'}, ` +
      `stadium ${t.strStadium ?? '?'}.\n${(t.strDescriptionEN ?? '').slice(0, 600)}`,
    source: 'TheSportsDB',
  };
}

/** ECB reference rates via Frankfurter — authoritative and keyless. */
export async function getFx(query: string): Promise<DataResult> {
  const m = /([A-Za-z]{3})\s*(?:to|\/|-|>)?\s*([A-Za-z]{3})?/.exec(query.trim());
  const from = (m?.[1] ?? 'EUR').toUpperCase();
  const to = (m?.[2] ?? 'USD').toUpperCase();
  const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, {
    headers: { 'user-agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
  const j = (await res.json()) as { date?: string; base?: string; rates?: Record<string, number> };
  const rate = j.rates?.[to];
  if (rate === undefined) throw new Error(`no rate for ${from}->${to}`);
  return {
    text: `1 ${j.base ?? from} = ${rate} ${to} (ECB reference rate, ${j.date ?? 'latest'})`,
    source: 'Frankfurter / ECB',
  };
}

/** CoinGecko public endpoint — keyless for simple price lookups. */
export async function getCrypto(query: string): Promise<DataResult> {
  const id = query.trim().toLowerCase().replace(/\s+/g, '-');
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}` +
      '&vs_currencies=usd,eur&include_24hr_change=true',
    { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, Record<string, number>>;
  const row = j[id];
  if (!row) throw new Error(`unknown coin id "${id}" (use the CoinGecko id, e.g. "bitcoin")`);
  return {
    text:
      `${id}: $${row.usd} USD / €${row.eur} EUR` +
      (row.usd_24h_change !== undefined ? ` (24h ${row.usd_24h_change.toFixed(2)}%)` : ''),
    source: 'CoinGecko',
  };
}

/** Yahoo Finance's public chart endpoint — keyless quotes for equities, ETFs,
 *  indices and FX pairs. Unofficial, so it is treated as best-effort. */
export async function getStock(query: string): Promise<DataResult> {
  const symbol = query.trim().split(/\s+/)[0]!.toUpperCase();
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
  const j = (await res.json()) as {
    chart?: {
      result?: {
        meta?: {
          symbol?: string;
          currency?: string;
          regularMarketPrice?: number;
          previousClose?: number;
          chartPreviousClose?: number;
          fullExchangeName?: string;
          regularMarketTime?: number;
        };
      }[];
      error?: { description?: string } | null;
    };
  };
  const meta = j.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) {
    throw new Error(j.chart?.error?.description ?? `no quote for "${symbol}"`);
  }
  const prev = meta.previousClose ?? meta.chartPreviousClose;
  const change =
    prev !== undefined ? ((meta.regularMarketPrice - prev) / prev) * 100 : undefined;
  const asOf = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : 'latest';
  return {
    text:
      `${meta.symbol ?? symbol}: ${meta.regularMarketPrice} ${meta.currency ?? ''}` +
      (prev !== undefined ? ` (previous close ${prev}` : '') +
      (change !== undefined ? `, ${change >= 0 ? '+' : ''}${change.toFixed(2)}%)` : prev !== undefined ? ')' : '') +
      `\nExchange: ${meta.fullExchangeName ?? 'unknown'} · as of ${asOf}`,
    source: 'Yahoo Finance',
  };
}

/**
 * World Bank open data — keyless macro indicators (GDP, inflation, population…).
 * Query form: "<ISO country> <indicator code>", e.g. "DE NY.GDP.MKTP.CD".
 */
export async function getMacro(query: string): Promise<DataResult> {
  const parts = query.trim().split(/\s+/);
  const country = (parts[0] ?? 'WLD').toUpperCase();
  const indicator = parts[1] ?? 'NY.GDP.MKTP.CD';
  const res = await fetch(
    `https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicator)}?format=json&per_page=5&mrv=5`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`worldbank HTTP ${res.status}`);
  const j = (await res.json()) as [
    unknown,
    { indicator?: { value?: string }; country?: { value?: string }; date?: string; value?: number | null }[]?,
  ];
  const rows = (j[1] ?? []).filter((r) => r.value !== null && r.value !== undefined);
  if (rows.length === 0) throw new Error(`no data for ${country} / ${indicator}`);
  const head = rows[0]!;
  const series = rows.map((r) => `- ${r.date}: ${r.value}`).join('\n');
  return {
    text: `${head.indicator?.value ?? indicator} — ${head.country?.value ?? country}\n${series}`,
    source: 'World Bank Open Data',
  };
}

export type DataKind = 'weather' | 'sports' | 'fx' | 'crypto' | 'stock' | 'macro';

export async function getData(kind: DataKind, query: string): Promise<DataResult> {
  switch (kind) {
    case 'weather':
      return getWeather(query);
    case 'sports':
      return getSports(query);
    case 'fx':
      return getFx(query);
    case 'crypto':
      return getCrypto(query);
    case 'stock':
      return getStock(query);
    case 'macro':
      return getMacro(query);
    default:
      throw new Error(`unknown kind "${String(kind)}"`);
  }
}
