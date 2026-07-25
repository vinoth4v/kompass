# Search backends (Research + AI Council)

Search runs as a three-tier chain in `src/lib/scrape.ts`. Each tier is tried in
order; an empty result set counts as a failure and falls through, because a 200
carrying a challenge page is what being blocked usually looks like.

`POST /api/tools/web_search` returns `backend` (what served the query) and
`tried` (what was rejected and why), so a failing chain is diagnosable from
outside.

## Tier 1 — keyed general web (best coverage, needs a free signup)

Set any of these as Vercel environment variables. They are read server-side only
and never reach the browser. Any provider without a key is skipped silently.

| Variable | Provider | Terms (verify before relying on these) |
| --- | --- | --- |
| `BRAVE_API_KEY` | [Brave Search API](https://api.search.brave.com/) | **not free**: $5 per 1,000 requests, with $5 of credit each month — so roughly 1,000 requests/month at no charge, but billing must be set up |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com/) | free tier advertised, built for agents |
| `SERPER_API_KEY` | [Serper](https://serper.dev/) | one-off free credits, Google results |
| `EXA_API_KEY` | [Exa](https://exa.ai/) | free tier advertised, neural/semantic search |

Brave was documented here as "2,000 queries/month free". That was wrong — the
dashboard shows per-request pricing with a monthly credit. Check each provider's
current pricing yourself rather than trusting this table; these terms change.

**None of these are required.** Tiers 2 and 3 below need no key and no signup.

```sh
vercel env add BRAVE_API_KEY production
vercel deploy --prod
```

Adding even one of these is the single biggest quality win available: the tiers
below cannot match a general web index.

## Tier 2 — keyless general web

| Backend | Kind | Datacenter IPs |
| --- | --- | --- |
| DuckDuckGo HTML | scrape | blocked (challenge page) |
| DuckDuckGo Lite | scrape | blocked |
| Mojeek | scrape | blocked (HTTP 403) |
| Marginalia | real API | works |
| mwmbl | real API | works |

The scrapes are kept because a local or self-hosted deployment is not blocked,
and they cost nothing when they fail. Marginalia and mwmbl are proper APIs, so
they cannot be refused the way a scrape can. Marginalia's index favours small
independent sites over commercial SEO pages — a strength for research, a
weakness for mainstream and news queries. mwmbl is community-crawled with modest
coverage.

## Tier 3 — keyless specialist APIs (always available)

Real APIs rather than scrapes, so they cannot block us the way the tier above
does. These are **aggregated in parallel and interleaved**, not raced: each is
narrow alone, and breadth is the whole point of the tier.

| Source | Covers |
| --- | --- |
| Hacker News (Algolia) | current tooling, launches, practitioner opinion |
| GitHub | what tooling actually exists and is maintained |
| Stack Overflow | concrete problems and accepted answers |
| Wikipedia | background and definitions |
| arXiv | primary research |

Interleaving matters: without it one prolific source crowds the others out of
the top results, which defeats the aggregation.

---

# Structured data tools

Separate from search, and deliberately so. Search returns pages a model must
read and interpret; these return the fact itself. For "EUR to USD" or "weather
in Berlin", a scraped search result is strictly worse than the number: slower,
longer, and an invitation to hallucinate.

All are keyless and were probed live from the deployed function before wiring.
Available in **Chat, Research and the AI Council** — they share one tool
definition and one executor (`src/lib/tools.ts`).

| Tool | Source | Returns |
| --- | --- | --- |
| `get_news` | Google News RSS | headlines with outlet and publication date |
| `get_data kind=weather` | Open-Meteo | current conditions + 3-day forecast |
| `get_data kind=fx` | Frankfurter (ECB) | official reference rate |
| `get_data kind=stock` | Yahoo Finance | quote, previous close, % change |
| `get_data kind=crypto` | CoinGecko | USD/EUR price, 24h change |
| `get_data kind=sports` | ESPN / TheSportsDB | live scores, fixtures, team profiles |
| `get_data kind=macro` | World Bank | indicator series, e.g. `DE NY.GDP.MKTP.CD` |

Six sources sit behind one `get_data` tool with a `kind` argument rather than
being exposed as six separate tools. These are free models with modest
tool-calling ability, and every additional tool measurably degrades their choice
of which to call.

Rejected after probing: GDELT (HTTP 429 — one request per five seconds),
Stooq (404 on the documented quote URL), NewsAPI (free tier is localhost-only,
so it cannot work on Vercel).

A successful structured lookup is recorded as a citable source, exactly like a
fetched page — the same rule applies: only on success, never because a model
said so.
