# 🧭 Kompass

**Classifier-routed free-model gateway for Claude Code, Codex, Cursor, Cline & more.** One
Cloudflare Worker exposes Anthropic (`/v1/messages`), OpenAI Chat Completions
(`/v1/chat/completions`) and OpenAI Responses (`/v1/responses`) endpoints that route your
coding traffic across **10 pooled free providers** (OpenRouter, NVIDIA Build, Google AI
Studio, Groq, Mistral, GitHub Models, Cloudflare Workers AI, SambaNova, Cohere, Hugging
Face — **30+ models across 5 complexity lanes**) — with a shared quota ledger across every
machine you code from. $0 infra, $0 models.

**Website & Setup Builder:** https://kompass-iota.vercel.app · **Docs:** https://kompass-iota.vercel.app/docs.html · MIT · Node 20+

## Install (the easy way)

```sh
git clone https://github.com/vinoth4v/kompass && cd kompass && pnpm install
pnpm kompass init   # wizard asks for your Cloudflare token + provider keys, then deploys everything
source ~/.zshrc     # activate claude-free in the current shell
```

The wizard handles everything: it installs Claude Code if it's missing, prompts for your
Cloudflare API token if it isn't set (no `export` step needed), collects provider keys, deploys
the Worker, and adds `claude-free` to your shell.

Token: [dash.cloudflare.com → API Tokens → "Edit Cloudflare Workers" template + KV Storage:Edit scope](https://dash.cloudflare.com/profile/api-tokens).

**Setting up on a second machine or after a re-clone:** copy `secrets/.secrets.json` from your
first machine (it includes your Cloudflare token and provider keys), then run `pnpm kompass init`
— it detects all existing resources and skips them, re-deploys secrets and config, and adds
`claude-free` to your shell. No `export` needed. If you prefer the manual path:

```sh
pnpm exec wrangler secret bulk secrets/.secrets.json            # sync bearer + provider keys to Worker
pnpm kompass config push --url https://kompass.<you>.workers.dev  # restore lane config in KV
```

### Where to create the free API keys

| Provider              | Create key at                                             | Notes                                                                 |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| OpenRouter            | https://openrouter.ai/keys                                | free `:free` models; buying $10 credits once lifts 50→1000 req/day    |
| NVIDIA Build          | https://build.nvidia.com (any model page → "Get API Key") | free tier, no card                                                    |
| Google AI Studio      | https://aistudio.google.com/apikey                        | free tier; your live limits: https://aistudio.google.com/rate-limit   |
| Groq                  | https://console.groq.com/keys                             | free tier, no card; ultra-fast small models                           |
| Mistral               | https://console.mistral.ai (Experiment tier)              | free tier trains on inputs — privacy guard keeps flagged content away |
| GitHub Models         | https://github.com/settings/personal-access-tokens        | fine-grained PAT, "Models: read" — frontier models, small daily caps  |
| Cloudflare Workers AI | https://dash.cloudflare.com/profile/api-tokens            | free tier; also powers image generation + embeddings                  |
| SambaNova             | https://cloud.sambanova.ai                                | free tier, no card                                                    |
| Cohere                | https://dashboard.cohere.com/api-keys                     | trial key, ~1000 calls/month                                          |
| Hugging Face          | https://huggingface.co/settings/tokens                    | "Make calls to Inference Providers" permission                        |

Any subset works — missing providers are skipped automatically. Prefer a form? The
[Setup Builder](https://kompass-iota.vercel.app#builder) has a field for every one of these.

The wizard is idempotent (safe to re-run), stores your keys only in the gitignored
`secrets/.secrets.json` + Cloudflare Worker secrets, and ends with a working
`claude-free` command in your shell. Prefer copy-paste? Use the
[Setup Builder](https://kompass-iota.vercel.app#builder) — it generates your
personalized files entirely in your browser. The manual path follows below.

```
Claude Code ──► Kompass Worker ──► FAST / SIMPLE / AGENTIC / HARD / LONGCTX lane
                 │  heuristics + Gemini flash-lite classifier
                 │  Durable Object: shared RPM/RPD ledger, health cooldowns, stickiness
                 └► OpenRouter · NVIDIA · Google · Groq · Mistral · GitHub Models ·
                    Cloudflare AI · SambaNova · Cohere · Hugging Face (any subset)
```

## 10-minute setup (manual path)

Prereqs: Node 22, pnpm, a Cloudflare account, and free API keys from the providers you want —
see the [table above](#where-to-create-the-free-api-keys) for signup links; any subset works,
missing providers are skipped.

```sh
git clone https://github.com/<you>/kompass && cd kompass
pnpm install

# 1. Cloudflare API token (Workers + KV + Durable Objects edit scopes)
export CLOUDFLARE_API_TOKEN=...

# 2. Secrets file (never committed — secrets/ is gitignored). Only KOMPASS_BEARER
#    is required; add whichever provider keys you have — see table above for the
#    remaining env var names (MISTRAL_API_KEY, GITHUB_MODELS_KEY, CF_WORKERS_AI_KEY,
#    SAMBANOVA_API_KEY, COHERE_API_KEY, HF_API_KEY).
mkdir -p secrets
cat > secrets/.secrets.json <<EOF
{
  "KOMPASS_BEARER": "$(openssl rand -hex 24)",
  "OPENROUTER_API_KEY": "sk-or-v1-...",
  "NVIDIA_API_KEY": "nvapi-...",
  "GOOGLE_AI_KEY": "AIza...",
  "GROQ_API_KEY": "gsk_..."
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

## Or point any other coding tool at it

The same Worker speaks three API dialects from one URL — all sharing the same lanes,
fallback chains and quota ledger. Your `KOMPASS_BEARER` is the API key everywhere.
Model name `kompass` = auto lane routing; `kompass-fast|-simple|-agentic|-hard|-longctx`
pins a lane. `GET /v1/models` lists them for client pickers.

| Dialect                     | Endpoint               | Used by                                               |
| --------------------------- | ---------------------- | ----------------------------------------------------- |
| Anthropic Messages API      | `/v1/messages`         | Claude Code                                           |
| OpenAI Chat Completions API | `/v1/chat/completions` | Cursor, Cline, Roo Code, Continue, Aider, most others |
| OpenAI Responses API        | `/v1/responses`        | Codex CLI                                             |

**Codex CLI** (`~/.codex/config.toml`):

```toml
model = "kompass"
model_provider = "kompass"

[model_providers.kompass]
name = "Kompass"
base_url = "https://kompass.<you>.workers.dev/v1"
env_key = "KOMPASS_API_KEY"   # export KOMPASS_API_KEY=<your bearer>
wire_api = "responses"
```

**Cursor**: Settings → Models → API Keys → paste the bearer as OpenAI API key, enable
"Override OpenAI Base URL" → `https://kompass.<you>.workers.dev/v1`, add custom model `kompass`.

**VS Code** has no built-in AI backend — install one of these free extensions first
(Extensions panel, `⇧⌘X`), then configure it:

**Cline / Roo Code / Kilo Code**: provider "OpenAI Compatible", base URL
`https://kompass.<you>.workers.dev/v1`, API key = bearer, model ID `kompass`. Full
click-by-click walkthrough (and how to pick between the three):
https://kompass-iota.vercel.app/docs.html#vscode

**Continue** (`config.yaml`, VS Code or JetBrains):

```yaml
models:
  - name: Kompass
    provider: openai
    model: kompass
    apiBase: https://kompass.<you>.workers.dev/v1
    apiKey: <your bearer token>
```

**Aider**:

```sh
export OPENAI_API_BASE=https://kompass.<you>.workers.dev/v1
export OPENAI_API_KEY=<your bearer token>
aider --model openai/kompass
```

## Day-to-day

| Command                                | Does                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm kompass status --url <url>`      | lanes, per-provider remaining quota, last 50 routes                                            |
| `pnpm kompass config push --url <url>` | hot-reload `config/*.yaml` — no redeploy                                                       |
| `pnpm kompass deploy`                  | `wrangler deploy` + secrets bulk push                                                          |
| `pnpm kompass logs`                    | live tail (`wrangler tail`)                                                                    |
| `pnpm kompass trace <id>`              | full detail for one routed request: verdict, every hop tried and why, latency, usage           |
| `pnpm kompass trace list [--n N]`      | recent traces (redacted), newest first                                                         |
| `pnpm kompass trace replay <id>`       | re-issue a full-capture trace's request, optionally `--lane`/`--model`                         |
| `pnpm kompass ui`                      | local web workbench (chat/agent/research/slides)                                               |
| `https://…workers.dev/status.html`     | analytics dashboard: daily/monthly consumption, model usage, quota, routes (enter bearer once) |

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

## Kompass AI — hosted chat app (`chat/`)

A full **Next.js app you deploy to your own Vercel account**, for when you want a
gateway UI reachable from any device — not just your laptop. Live reference deploy:
**https://kompass-chat.vercel.app** (point it at your own worker + bearer to use it
for real; each user hosts their own instance, same one-user model as the gateway
itself).

- **Login is the bearer** — enter your Worker URL and `KOMPASS_BEARER` once; it's
  validated live and stored only in that browser's localStorage, sent straight to
  your Worker on every request (never to a third party, no server-side session).
- **Chat** — multi-conversation sidebar, markdown + syntax-highlighted code blocks,
  image/PDF attachments (vision), edit-and-resend, regenerate, and a per-reply
  footer showing which model actually served it (`x-kompass-served-by` /
  `x-kompass-lane` response headers) plus token usage.
- **Image** — generates via `/v1/images/generations`, shown inline with a download
  button.
- **Research** — a real tool-use loop: the model calls `web_search`/`web_fetch`
  (executed by two Vercel serverless routes, ported from `kompass ui`'s DDG-scrape
  tools — a browser can't fetch duckduckgo.com directly due to CORS) and the
  answer renders with clickable source citations.
- Lane picker (Auto/Fast/Simple/Agentic/Hard/Long context), light/dark theme,
  mobile-responsive with a slide-over sidebar.

Not ported: the local UI's Agent (bash/file) and Slides tools — no user filesystem
exists in a hosted serverless context, so those stay `kompass ui`-only.

Deploy your own:

```sh
cd chat && npm install && npm run build
vercel link && vercel deploy --prod    # or: vercel --prod
```

Requires the Worker's CORS (ships by default — see `src/worker/index.ts`) so a
different origin can call `/v1/messages`, `/v1/images/generations`, etc.

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

## Enable or disable a model

Flip a model off without deleting it from `lanes.yaml` — for a flaky endpoint,
a paused experiment, or anything you want to stop calling but might restore later:

```sh
pnpm kompass models disable openrouter/poolside/laguna-m.1:free
pnpm kompass models enable  openrouter/poolside/laguna-m.1:free
pnpm kompass models list                # ✓/✗ status for every configured entry
```

Each command edits `config/lanes.yaml`'s `disabled_models` list (preserving every
comment) and validates before writing — an invalid entry reverts with no changes.
Run `pnpm kompass config push` afterward to apply. A disabled entry stays visible
in its lane's chain (struck through on the [status dashboard](#day-to-day)'s Config
tab) but is skipped everywhere it would otherwise be tried: chat lanes, the
`/v1/images` and `/v1/embeddings` chains, and the classifier. This is the reversible
sibling of `kompass deprecate` (which permanently rewrites an entry to a
replacement at every config push).

## Design, game & creative coding work

The lanes cover creative _coding_ — web/UI design, CSS/WebGL animation, game code
(three.js, Phaser, Godot). A 2026-07-23 tool-probe pass added
`poolside/laguna-m.1:free` and `nvidia/nemotron-3-super-120b-a12b:free` (AGENTIC)
plus `mistralai/mistral-small-4-119b-2603` (SIMPLE) for exactly this traffic; probe
results and exclusions are recorded in `config/lanes.yaml` comments and
`docs/DECISIONS.md`.

**Image generation is built in** (2026-07-24): `POST /v1/images/generations`
(OpenAI Images API-compatible) routes free Workers AI models
(flux-1-schnell → SDXL-lightning fallback) through the same quota ledger:

```sh
curl https://kompass.<you>.workers.dev/v1/images/generations \
  -H "x-api-key: <bearer>" -H "content-type: application/json" \
  -d '{"prompt": "a minimalist compass logo"}'   # → {data: [{b64_json: ...}]}
```

**Embeddings too**: `POST /v1/embeddings` (OpenAI-compatible — works with
Continue's indexing, RAG pipelines, etc.) routes Workers AI `bge-m3` (1024 dims)
with a Gemini-embedding fallback (3072 dims — pin one entry via the chain if your
vector store needs stable dimensions). Both chains live in `config/lanes.yaml`
(`images:` / `embeddings:`).

**Vision input** (images/PDFs in chat) is served by Gemini plus per-model vision
fallbacks on OpenRouter/NVIDIA (`multimodal_models` in `config/providers.yaml`),
so image traffic survives a Google quota-out. Still direct-only (no gateway
endpoint yet): video (`veo-3.1-*`) and music (`lyria-3`) generation on your AI
Studio key — free-quota-gated at ship time; see `BUILD_PLAN.md` §8.

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

**Trace store (M7):** every routed request is logged to a 500-entry Durable Object
ring buffer — lane, dispatcher verdict, which models were tried and why, latency,
token usage — for `kompass trace <id>` / `kompass trace list` / `kompass trace replay`.
**Redaction is the default**: the stored record never contains your raw prompt, only a
one-way SHA-256 fingerprint for correlation. Full capture (the actual request body, so
`kompass trace replay` can re-issue it against a different lane/model) is opt-in per
request via the `X-Kompass-Trace: full` header, stored separately from the redacted
ring buffer, and auto-expires after 1 hour.

## Development

```sh
pnpm typecheck && pnpm lint && pnpm test   # all green before any commit
pnpm dev                                   # local worker (wrangler dev)
scripts/readme-dryrun.sh                   # CI: fresh-clone dry run (no deploy)
```

Decisions log: `docs/DECISIONS.md` · Spec: `docs/SPEC.md` · Build plan: `BUILD_PLAN.md`.
MIT license.
