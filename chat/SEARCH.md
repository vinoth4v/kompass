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

| Variable | Provider | Free tier |
| --- | --- | --- |
| `BRAVE_API_KEY` | [Brave Search API](https://api.search.brave.com/) | 2,000 queries/month |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com/) | 1,000 credits/month, built for agents |
| `SERPER_API_KEY` | [Serper](https://serper.dev/) | 2,500 one-off credits, Google results |
| `EXA_API_KEY` | [Exa](https://exa.ai/) | free tier, neural/semantic search |

```sh
vercel env add BRAVE_API_KEY production
vercel deploy --prod
```

Adding even one of these is the single biggest quality win available: the tiers
below cannot match a general web index.

## Tier 2 — scraped general web (no key, blocked on Vercel)

DuckDuckGo HTML, DuckDuckGo Lite, Mojeek. Measured live from the deployed
function: DuckDuckGo returns a challenge page and Mojeek returns HTTP 403 —
**every one of them blocks datacenter IPs**. They are kept because a local or
self-hosted deployment is not blocked, and they cost nothing when they fail.

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
