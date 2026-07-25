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
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(12_000),
  });
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
    daily?: {
      time?: string[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_sum?: number[];
    };
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
      events?: {
        name?: string;
        date?: string;
        status?: { type?: { detail?: string } };
        competitions?: { competitors?: { team?: { displayName?: string }; score?: string }[] }[];
      }[];
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
    teams?: {
      strTeam?: string;
      strLeague?: string;
      intFormedYear?: string;
      strStadium?: string;
      strDescriptionEN?: string;
    }[];
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
    {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    },
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
  const change = prev !== undefined ? ((meta.regularMarketPrice - prev) / prev) * 100 : undefined;
  const asOf = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : 'latest';
  return {
    text:
      `${meta.symbol ?? symbol}: ${meta.regularMarketPrice} ${meta.currency ?? ''}` +
      (prev !== undefined ? ` (previous close ${prev}` : '') +
      (change !== undefined
        ? `, ${change >= 0 ? '+' : ''}${change.toFixed(2)}%)`
        : prev !== undefined
          ? ')'
          : '') +
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
    {
      indicator?: { value?: string };
      country?: { value?: string };
      date?: string;
      value?: number | null;
    }[]?,
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

/* ─────────────────────────────────────────────────────────────────────────────
   Reference sources. Distinct from the live-value sources above: these answer
   "what is known about X" from an authoritative register rather than "what is
   the number right now". Split into their own tool so neither enum grows long
   enough to confuse a small model's tool choice.
   ──────────────────────────────────────────────────────────────────────────── */

/** PubMed — biomedical literature. Two calls: search for ids, then summarise. */
export async function getPubmed(query: string): Promise<DataResult> {
  const ids = (await (
    await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=5&term=${encodeURIComponent(query)}`,
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
    )
  ).json()) as { esearchresult?: { idlist?: string[] } };
  const list = ids.esearchresult?.idlist ?? [];
  if (list.length === 0) throw new Error(`no PubMed results for "${query}"`);
  const sum = (await (
    await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${list.join(',')}`,
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
    )
  ).json()) as { result?: Record<string, { title?: string; pubdate?: string; source?: string }> };
  const rows = list
    .map((id) => {
      const r = sum.result?.[id];
      return r
        ? `- ${r.title} (${r.source ?? '?'}, ${r.pubdate ?? '?'}) https://pubmed.ncbi.nlm.nih.gov/${id}/`
        : '';
    })
    .filter(Boolean);
  return { text: `PubMed results for "${query}":\n${rows.join('\n')}`, source: 'PubMed' };
}

/** openFDA drug labels — indications, warnings, dosage. */
export async function getDrug(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://api.fda.gov/drug/label.json?limit=1&search=openfda.generic_name:${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`openFDA HTTP ${res.status}`);
  const j = (await res.json()) as {
    results?: {
      openfda?: { brand_name?: string[]; generic_name?: string[] };
      indications_and_usage?: string[];
      warnings?: string[];
      dosage_and_administration?: string[];
    }[];
  };
  const r = j.results?.[0];
  if (!r) throw new Error(`no FDA label for "${query}"`);
  const clip = (a?: string[]) => (a?.[0] ?? '').replace(/\s+/g, ' ').slice(0, 700);
  return {
    text:
      `${(r.openfda?.brand_name ?? r.openfda?.generic_name ?? [query]).join(', ')}\n` +
      `INDICATIONS: ${clip(r.indications_and_usage) || 'n/a'}\n` +
      `DOSAGE: ${clip(r.dosage_and_administration) || 'n/a'}\n` +
      `WARNINGS: ${clip(r.warnings) || 'n/a'}`,
    source: 'openFDA (US drug labels)',
  };
}

/** ClinicalTrials.gov — study registry. */
export async function getTrials(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://clinicaltrials.gov/api/v2/studies?pageSize=5&query.term=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`clinicaltrials HTTP ${res.status}`);
  const j = (await res.json()) as {
    studies?: {
      protocolSection?: {
        identificationModule?: { nctId?: string; briefTitle?: string };
        statusModule?: { overallStatus?: string };
        designModule?: { phases?: string[] };
      };
    }[];
  };
  const rows = (j.studies ?? []).map((st) => {
    const p = st.protocolSection;
    const id = p?.identificationModule?.nctId;
    return `- ${p?.identificationModule?.briefTitle ?? id} [${p?.statusModule?.overallStatus ?? '?'}${
      p?.designModule?.phases?.length ? ', ' + p.designModule.phases.join('/') : ''
    }] https://clinicaltrials.gov/study/${id}`;
  });
  if (rows.length === 0) throw new Error(`no trials for "${query}"`);
  return {
    text: `Clinical trials for "${query}":\n${rows.join('\n')}`,
    source: 'ClinicalTrials.gov',
  };
}

/** USGS — recent earthquakes, magnitude filterable via the query. */
export async function getQuakes(query: string): Promise<DataResult> {
  const min = /(\d(?:\.\d)?)/.exec(query)?.[1] ?? '4.5';
  const res = await fetch(
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=8&orderby=time&minmagnitude=${min}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`usgs HTTP ${res.status}`);
  const j = (await res.json()) as {
    features?: { properties?: { mag?: number; place?: string; time?: number; url?: string } }[];
  };
  const rows = (j.features ?? []).map((f) => {
    const p = f.properties ?? {};
    return `- M${p.mag} ${p.place} — ${p.time ? new Date(p.time).toISOString() : '?'}`;
  });
  if (rows.length === 0) throw new Error('no events');
  return { text: `Recent earthquakes (M${min}+):\n${rows.join('\n')}`, source: 'USGS' };
}

/** Open Library — books and authors. */
export async function getBook(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://openlibrary.org/search.json?limit=5&fields=title,author_name,first_publish_year,key&q=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`openlibrary HTTP ${res.status}`);
  const j = (await res.json()) as {
    docs?: { title?: string; author_name?: string[]; first_publish_year?: number; key?: string }[];
  };
  const rows = (j.docs ?? []).map(
    (d) =>
      `- ${d.title} — ${(d.author_name ?? ['unknown']).join(', ')} (${d.first_publish_year ?? '?'}) https://openlibrary.org${d.key}`,
  );
  if (rows.length === 0) throw new Error(`no books for "${query}"`);
  return { text: `Books matching "${query}":\n${rows.join('\n')}`, source: 'Open Library' };
}

/**
 * Country facts via the World Bank country register plus its population
 * indicator. REST Countries was used here until 2026-07-25, when every version
 * of it began returning HTTP 200 with {"success":false,"errors":[{"message":
 * "This API version has been deprecated..."}]} — a 200 carrying a failure,
 * which is exactly the shape that makes an integration look fine and answer
 * nothing. World Bank is a public institutional API with no key and no
 * registration, so it will not quietly turn into a signup wall.
 */
export async function getCountry(query: string): Promise<DataResult> {
  const listRes = await fetch('https://api.worldbank.org/v2/country?format=json&per_page=400', {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!listRes.ok) throw new Error(`worldbank HTTP ${listRes.status}`);
  const list = (await listRes.json()) as [
    unknown,
    {
      id?: string;
      iso2Code?: string;
      name?: string;
      region?: { value?: string };
      capitalCity?: string;
      incomeLevel?: { value?: string };
    }[]?,
  ];
  const q = query.trim().toLowerCase();
  const rows = list[1] ?? [];
  const c =
    rows.find((r) => r.name?.toLowerCase() === q) ??
    rows.find((r) => r.iso2Code?.toLowerCase() === q || r.id?.toLowerCase() === q) ??
    rows.find((r) => r.name?.toLowerCase().includes(q));
  // Aggregates (regions, income groups) have no capital — exclude them so
  // "Europe" does not come back as if it were a country.
  if (!c || !c.capitalCity) throw new Error(`no country matching "${query}"`);

  let population = '';
  try {
    const p = await fetch(
      `https://api.worldbank.org/v2/country/${c.id}/indicator/SP.POP.TOTL?format=json&per_page=1&mrv=1`,
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
    );
    const pj = (await p.json()) as [unknown, { date?: string; value?: number | null }[]?];
    const row = (pj[1] ?? [])[0];
    if (row?.value) population = `\n- population: ${row.value.toLocaleString()} (${row.date})`;
  } catch {
    /* population is a bonus, not a reason to fail the lookup */
  }

  return {
    text:
      `${c.name} (${c.id})\n- capital: ${c.capitalCity}\n- region: ${c.region?.value ?? '?'}\n` +
      `- income group: ${c.incomeLevel?.value ?? '?'}${population}`,
    source: 'World Bank',
  };
}

/** npm or PyPI package metadata — version, license, description, homepage. */
export async function getPackage(query: string): Promise<DataResult> {
  const [eco, ...rest] = query.trim().split(/\s+/);
  const isPy = /^(py|pypi|python)$/i.test(eco ?? '');
  const name = (isPy ? rest.join(' ') : query).trim();
  if (isPy) {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`pypi HTTP ${res.status}`);
    const j = (await res.json()) as {
      info?: {
        version?: string;
        summary?: string;
        license?: string;
        home_page?: string;
        project_url?: string;
      };
    };
    const i = j.info ?? {};
    return {
      text: `${name} (PyPI) v${i.version}\n${i.summary ?? ''}\nlicense: ${i.license || 'n/a'}\n${i.project_url ?? i.home_page ?? ''}`,
      source: 'PyPI',
    };
  }
  // The full npm document can exceed 6MB; /latest is the small view.
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`npm HTTP ${res.status}`);
  const j = (await res.json()) as {
    version?: string;
    description?: string;
    license?: string;
    homepage?: string;
  };
  return {
    text: `${name} (npm) v${j.version}\n${j.description ?? ''}\nlicense: ${j.license ?? 'n/a'}\n${j.homepage ?? ''}`,
    source: 'npm registry',
  };
}

/** NVD — published CVEs by keyword. */
export async function getCve(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=5&keywordSearch=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`nvd HTTP ${res.status}`);
  const j = (await res.json()) as {
    vulnerabilities?: {
      cve?: {
        id?: string;
        published?: string;
        descriptions?: { lang?: string; value?: string }[];
        metrics?: {
          cvssMetricV31?: { cvssData?: { baseScore?: number; baseSeverity?: string } }[];
        };
      };
    }[];
  };
  const rows = (j.vulnerabilities ?? []).map((v) => {
    const c = v.cve ?? {};
    const m = c.metrics?.cvssMetricV31?.[0]?.cvssData;
    const desc = (c.descriptions ?? []).find((d) => d.lang === 'en')?.value ?? '';
    return `- ${c.id} [${m?.baseSeverity ?? '?'} ${m?.baseScore ?? ''}] ${desc.slice(0, 180)}`;
  });
  if (rows.length === 0) throw new Error(`no CVEs for "${query}"`);
  return { text: `CVEs matching "${query}":\n${rows.join('\n')}`, source: 'NVD (NIST)' };
}

/** Open Food Facts — product nutrition. */
export async function getFood(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://world.openfoodfacts.org/api/v2/search?page_size=3&fields=product_name,brands,nutriscore_grade,nutriments&search_terms=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`openfoodfacts HTTP ${res.status}`);
  const j = (await res.json()) as {
    products?: {
      product_name?: string;
      brands?: string;
      nutriscore_grade?: string;
      nutriments?: Record<string, number>;
    }[];
  };
  const rows = (j.products ?? [])
    .filter((p) => p.product_name)
    .map((p) => {
      const n = p.nutriments ?? {};
      return (
        `- ${p.product_name}${p.brands ? ` (${p.brands})` : ''} — nutri-score ${(p.nutriscore_grade ?? '?').toUpperCase()}, ` +
        `${n['energy-kcal_100g'] ?? '?'} kcal/100g, sugar ${n.sugars_100g ?? '?'}g, fat ${n.fat_100g ?? '?'}g`
      );
    });
  if (rows.length === 0) throw new Error(`no products for "${query}"`);
  return {
    text: `Food products matching "${query}":\n${rows.join('\n')}`,
    source: 'Open Food Facts',
  };
}

/** Wikidata — structured entity facts, better than prose for identities. */
export async function getEntity(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=5&origin=*&search=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`wikidata HTTP ${res.status}`);
  const j = (await res.json()) as {
    search?: { id?: string; label?: string; description?: string }[];
  };
  const rows = (j.search ?? []).map(
    (e) => `- ${e.label} (${e.id}): ${e.description ?? ''} https://www.wikidata.org/wiki/${e.id}`,
  );
  if (rows.length === 0) throw new Error(`no entity "${query}"`);
  return { text: `Wikidata entities for "${query}":\n${rows.join('\n')}`, source: 'Wikidata' };
}

/** MusicBrainz — artists and releases. */
export async function getMusic(query: string): Promise<DataResult> {
  const res = await fetch(
    `https://musicbrainz.org/ws/2/artist?fmt=json&limit=5&query=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) throw new Error(`musicbrainz HTTP ${res.status}`);
  const j = (await res.json()) as {
    artists?: {
      name?: string;
      country?: string;
      disambiguation?: string;
      'life-span'?: { begin?: string; end?: string };
      id?: string;
    }[];
  };
  const rows = (j.artists ?? []).map(
    (a) =>
      `- ${a.name}${a.country ? ` (${a.country})` : ''} ${a['life-span']?.begin ?? ''}${a['life-span']?.end ? `–${a['life-span'].end}` : ''} ${a.disambiguation ?? ''}`,
  );
  if (rows.length === 0) throw new Error(`no artist "${query}"`);
  return { text: `MusicBrainz artists for "${query}":\n${rows.join('\n')}`, source: 'MusicBrainz' };
}

export type ReferenceKind =
  | 'pubmed'
  | 'drug'
  | 'trials'
  | 'quakes'
  | 'book'
  | 'country'
  | 'package'
  | 'cve'
  | 'food'
  | 'entity'
  | 'music';

export async function getReference(kind: ReferenceKind, query: string): Promise<DataResult> {
  switch (kind) {
    case 'pubmed':
      return getPubmed(query);
    case 'drug':
      return getDrug(query);
    case 'trials':
      return getTrials(query);
    case 'quakes':
      return getQuakes(query);
    case 'book':
      return getBook(query);
    case 'country':
      return getCountry(query);
    case 'package':
      return getPackage(query);
    case 'cve':
      return getCve(query);
    case 'food':
      return getFood(query);
    case 'entity':
      return getEntity(query);
    case 'music':
      return getMusic(query);
    default:
      throw new Error(`unknown reference kind "${String(kind)}"`);
  }
}
