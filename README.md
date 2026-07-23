# 🧭 Kompass

**Classifier-routed free-model gateway for Claude Code.** One Cloudflare Worker exposes an
Anthropic-compatible `/v1/messages` endpoint that routes your Claude Code traffic across
free model providers (OpenRouter `:free`, NVIDIA Build, Google AI Studio, Groq) by task
complexity — with a shared quota ledger across every machine you code from. $0 infra, $0 models.

**Website & Setup Builder:** https://kompass-iota.vercel.app · MIT · Node 20+

## Install (the easy way)

```sh
git clone https://github.com/vinoth4v/kompass && cd kompass && pnpm install
export CLOUDFLARE_API_TOKEN=...   # dash.cloudflare.com → API Tokens → "Edit Cloudflare Workers" + KV edit
pnpm kompass init                 # guided: keys → KV → workers.dev URL → deploy → smoke → shell function
```

### Where to create the free API keys

| Provider         | Create key at                                             | Notes                                                               |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| OpenRouter       | https://openrouter.ai/keys                                | free `:free` models; buying $10 credits once lifts 50→1000 req/day  |
| NVIDIA Build     | https://build.nvidia.com (any model page → "Get API Key") | free tier, no card                                                  |
| Google AI Studio | https://aistudio.google.com/apikey                        | free tier; your live limits: https://aistudio.google.com/rate-limit |
| Groq             | https://console.groq.com/keys                             | free tier, no card; ultra-fast small models                         |

Any subset works — missing providers are skipped automatically.

The wizard is idempotent (safe to re-run), stores your keys only in the gitignored
`secrets/.secrets.json` + Cloudflare Worker secrets, and ends with a working
`claude-free` command in your shell. Prefer copy-paste? Use the
[Setup Builder](https://kompass-iota.vercel.app#builder) — it generates your
personalized files entirely in your browser. The manual path follows below.

```
Claude Code ──► Kompass Worker ──► FAST / SIMPLE / AGENTIC / HARD / LONGCTX lane
                 │  heuristics + Gemini flash-lite classifier
                 │  Durable Object: shared RPM/RPD ledger, health cooldowns, stickiness
                 └► OpenRouter · NVIDIA Build · Google AI Studio · (Groq)
```

## 10-minute setup (manual path)

Prereqs: Node 22, pnpm, a Cloudflare account, and free API keys from the providers you want
([OpenRouter](https://openrouter.ai/keys), [NVIDIA Build](https://build.nvidia.com),
[Google AI Studio](https://aistudio.google.com/apikey), [Groq](https://console.groq.com/keys) —
any subset works; missing providers are skipped).

```sh
git clone https://github.com/<you>/kompass && cd kompass
pnpm install

# 1. Cloudflare API token (Workers + KV + Durable Objects edit scopes)
export CLOUDFLARE_API_TOKEN=...

# 2. Secrets file (never committed — secrets/ is gitignored)
mkdir -p secrets
cat > secrets/.secrets.json <<EOF
{
  "KOMPASS_BEARER": "$(openssl rand -hex 24)",
  "OPENROUTER_API_KEY": "sk-or-v1-...",
  "NVIDIA_API_KEY": "nvapi-...",
  "GOOGLE_AI_KEY": "AIza..."
}
EOF

# 3. Create your KV namespace and put its id into wrangler.jsonc
pnpm exec wrangler kv namespace create CONFIG

# 4. Deploy worker + secrets, then push the lane table
pnpm exec wrangler deploy
pnpm exec wrangler secret bulk secrets/.secrets.json
KOMPASS_URL=https://kompass.<your-subdomain>.workers.dev pnpm kompass config push

# 5. Verify end-to-end against the deployed URL
pnpm smoke -- --url https://kompass.<your-subdomain>.workers.dev
```

## Point Claude Code at it

Add to `~/.zshrc` (the bearer is the `KOMPASS_BEARER` you generated):

```sh
claude-free() {
  ANTHROPIC_BASE_URL="https://kompass.<your-subdomain>.workers.dev" \
  ANTHROPIC_AUTH_TOKEN="<your KOMPASS_BEARER>" \
  ANTHROPIC_MODEL="claude-sonnet-4-5" \
  claude "$@"
}
```

Then `claude-free` anywhere. Hit your Claude Pro limit mid-feature? Type `claude-free` and
keep going on free models. Works identically from every machine — the quota ledger,
session stickiness, and health state live in one Durable Object, not on your laptop.

## Day-to-day

| Command                                | Does                                                |
| -------------------------------------- | --------------------------------------------------- |
| `pnpm kompass status --url <url>`      | lanes, per-provider remaining quota, last 50 routes |
| `pnpm kompass config push --url <url>` | hot-reload `config/*.yaml` — no redeploy            |
| `pnpm kompass deploy`                  | `wrangler deploy` + secrets bulk push               |
| `pnpm kompass logs`                    | live tail (`wrangler tail`)                         |
| `pnpm kompass ui`                      | local web workbench (chat/agent/research/slides)    |
| `https://…workers.dev/status.html`     | read-only status page (enter bearer once)           |

## Web workbench (`kompass ui`)

`pnpm kompass ui` starts a local claude.ai-style interface at `http://127.0.0.1:4876`
with four modes, all routed through your Kompass gateway:

- **Chat** — plain conversation with markdown rendering.
- **Agent** — Claude Code-style coding agent: bash, read/write/edit files, search — in
  a workspace directory you choose, with per-action approval (or auto-approve).
- **Research** — the model runs web searches (DuckDuckGo, no API key) and reads pages,
  then writes a sourced report.
- **Slides** — describe a deck; the model designs it and generates a real downloadable
  `.pptx` (optionally researching the topic first).

Everything runs locally: sessions are saved under `~/.kompass/ui/`, tools execute on
your machine, and the browser only ever talks to the local server — your Kompass
bearer never reaches the page. The sidebar shows live per-provider quota.

## Add a model in 4 lines

Edit `config/lanes.yaml` (chain entries are `<provider>/<model>`; the model half may
contain slashes), then `pnpm kompass config push`:

```yaml
AGENTIC:
  - openrouter/poolside/laguna-s-2.1:free
  - nvidia/z-ai/glm-5.2
```

New provider = one YAML block in `config/providers.yaml` (kind: `openai` or `gemini`,
base_url, key_env, limits) + the key in your secrets file + `wrangler secret bulk`.

## How routing works

1. **Heuristics (0ms):** <1k tokens & no tools → FAST; >60k tokens → LONGCTX.
2. **Classifier:** otherwise a compressed task digest goes to a fast free reasoning model
   (Gemini Flash-Lite) returning strict JSON `{"lane":"AGENTIC","confidence":0.87}`.
   Verdicts are cached 5 min; confidence <0.6 or any classifier failure → AGENTIC. Never blocks.
3. **Ledger:** exhausted (RPM/RPD) and cooling-down (10 min after a failure) models are
   skipped up front; fallback walks the chain on 429/5xx/timeout. Zero-429 handoffs.
4. **Stickiness:** a session stays on its model between turns to preserve coherence.

**Paid models can never be called** unless you set `allow_paid: true` in `lanes.yaml`
(enforced in code at config-push _and_ request time; default false).

## Trust model

Your prompts and code transit **your own** Cloudflare Worker (Cloudflare is the host; only
you hold the bearer token — the Worker is never an open proxy) and are forwarded to
whichever free model provider serves the lane. Free endpoints may train on inputs
(OpenRouter `:free` endpoints are flagged `trains_on_data` in the registry; a privacy
guard for path/secret patterns ships in M5). If that is unacceptable for your repo, use
paid tiers or a self-hosted deployment target (planned P2) — and don't point sensitive
work at free endpoints.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test   # all green before any commit
pnpm dev                                   # local worker (wrangler dev)
scripts/readme-dryrun.sh                   # CI: fresh-clone dry run (no deploy)
```

Decisions log: `docs/DECISIONS.md` · Spec: `docs/SPEC.md` · Build plan: `BUILD_PLAN.md`.
MIT license.
