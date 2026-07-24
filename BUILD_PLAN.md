# Kompass — BUILD_PLAN.md

Autonomous build plan for Claude Code. Read together with `docs/SPEC.md` (v0.2, Worker-first).
Execute milestones **in strict order M0 → M5** under the guardrails in **§6**.

---

## §1. Goal

Ship Kompass v1: a single-user Cloudflare Worker exposing an Anthropic-compatible
`/v1/messages` endpoint that routes Claude Code traffic across free model providers
(OpenRouter `:free`, NVIDIA Build, Google AI Studio, Groq) using a fast-reasoning-model
Dispatcher, with a Durable Object quota ledger shared across all client machines.

Success = a real Claude Code session works end-to-end against the deployed
`workers.dev` URL from two machines, on free models only, surviving a simulated
provider outage.

---

## §2. Human prerequisites (ONE-TIME, before autonomous run — ~10 min)

The agent CANNOT do browser OAuth or create accounts. The human must prepare:

1. Cloudflare account + API token (Edit Workers + KV + Durable Objects scopes)
   → export as `CLOUDFLARE_API_TOKEN` (enables fully non-interactive `wrangler deploy`).
2. Provider keys collected into an untracked file `secrets/.secrets.json`:
   ```json
   {
     "KOMPASS_BEARER": "<generate: openssl rand -hex 24>",
     "OPENROUTER_API_KEY": "sk-or-v1-...",
     "NVIDIA_API_KEY": "nvapi-...",
     "GOOGLE_AI_KEY": "AIza...",
     "GROQ_API_KEY": "gsk_..."
   }
   ```
   (Any key may be missing; the agent must degrade gracefully and note it in DECISIONS.md.)
3. Node 22 LTS active (`node -v` → v22.x), pnpm installed.
4. `git remote origin` configured and pushable.

If any prerequisite is missing at start, write `docs/BLOCKERS.md` and stop only the
blocked step — continue all non-dependent work (offline dev via `wrangler dev` with
a `MemoryStore` shim).

---

## §3. Tech stack & repo layout (fixed decisions — do not relitigate)

- TypeScript strict · **Hono** on Cloudflare Workers · **wrangler** v4+
- State: Durable Object behind a `StateStore` interface (`MemoryStore | DurableObjectStore`)
- Config: lane table + provider registry as YAML in `config/`, compiled to JSON, pushed to Workers KV
- Tests: **vitest** + `@cloudflare/vitest-pool-workers`; lint: eslint + prettier
- Package manager: **pnpm** (mirror the visufinanz lesson: never mix npm into a pnpm repo)
- NO Node-only APIs (fs/net/child_process) inside `src/worker/` — CI must enforce via eslint rule

```
kompass/
  src/worker/        # Worker entry, ingress, auth, adapters, dispatcher, lanes
  src/do/            # Durable Object: ledger, stickiness, health, verdict cache
  src/adapters/      # anthropic.ts, openai.ts, gemini.ts (+ shared tool-schema xlate)
  src/cli/           # kompass CLI (deploy/status/logs/config push) — Node allowed here
  config/            # providers.yaml, lanes.yaml
  scripts/smoke.ts   # Anthropic-protocol smoke harness (streaming + tool round-trip)
  test/
  docs/              # SPEC.md, DECISIONS.md, BLOCKERS.md, MORNING_REPORT.md
```

---

## §4. Milestones

### M0 — Scaffold + passthrough (deploy on day one)

Tasks:

- pnpm scaffold, Hono Worker, bearer-auth middleware (401 without `KOMPASS_BEARER`).
- `/v1/messages` passthrough → ONE hardcoded OpenRouter model (`poolside/laguna-s-2.1:free`,
  fallback slug if dead: `qwen/qwen3-coder:free`) via the Anthropic→OpenAI adapter, **SSE streaming intact**.
- `wrangler secret bulk secrets/.secrets.json` (script it); deploy to `workers.dev`.
- `scripts/smoke.ts`: sends (a) streamed completion, (b) a tool-use round-trip shaped
  exactly like Claude Code traffic; run against the DEPLOYED URL.
  Acceptance:
- [ ] smoke passes against deployed URL; 401 without bearer
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green
      Verify-live note: before hardcoding the model, `GET https://openrouter.ai/api/v1/models`
      and confirm the `:free` slug has ≥1 active endpoint (dead-listing trap — see SPEC §prior-art).

### M1 — Adapters + registry + hot-reload

- Gemini adapter (`generateContent`, incl. tool-schema translation both directions).
- `providers.yaml` + `lanes.yaml` → compiled JSON → KV; authenticated `POST /config`;
  `kompass config push` CLI subcommand.
- Verify at runtime which providers have live keys; disabled providers logged, not fatal.
  Acceptance:
- [ ] identical toy tool-call task passes on one OpenAI-format model AND one Gemini model
- [ ] config push changes the active chain with no redeploy (prove in a test)

### M2 — Durable Object: ledger, fallback, stickiness, health

- RPM/RPD counters per provider (limits declared in providers.yaml); pre-emptive skip.
- Ordered fallback on 429/5xx/timeout; per-model health cooldown (10 min).
- Session stickiness keyed on Claude Code session; released on escalation.
  Acceptance:
- [ ] test: exhaust provider A's RPD in the DO → next request routes to provider B with zero 429s
- [ ] test: primary killed mid-stream → fallback completes; hop logged
- [ ] two `wrangler dev --remote` clients share one ledger (multi-machine proof)

### M3 — Dispatcher classifier

- Heuristic pre-filter (tokens<1k & no tools→FAST; ctx>60k→LONGCTX) short-circuits first.
- Classifier call: Gemini Flash-Lite (verify current free model id at ai.google.dev
  BEFORE coding; log the chosen id in DECISIONS.md) with strict-JSON verdict,
  confidence<0.6 → AGENTIC, verdict cache in DO (5 min).
- Classifier unavailable → heuristics-only, never block.
  Acceptance:
- [ ] p50 added latency <400ms measured by smoke harness (20 mixed requests)
- [ ] forced classifier 429 in test → requests still route

### M4 — CLI + status + docs

- `kompass status` (lanes, per-provider remaining quota, last 50 routes) reading the
  Worker's authenticated `/status` JSON; read-only HTML status page on same data.
- README: 10-minute setup incl. `claude-free()` shell function, secrets guide, trust
  model note (prompts transit Cloudflare; self-host adapter is P2).
  Acceptance:
- [ ] fresh-clone dry run of README steps scripted in CI (minus real deploy)

### M5 — P1 hardening

- Privacy guard (glob+regex blocklist for `trains_on_data: true` providers).
- Failure escalation (≥3 failed tool iterations → lane up; HARD exhausted → synthetic
  "switch to native claude" assistant notice).
- `kompass bench` harness stub over `test/tasks/*.md` (10 task files, results table).
  Acceptance:
- [ ] escalation state machine unit-tested; privacy guard blocks a seeded secret pattern

---

## §5. Verification protocol per milestone

`pnpm typecheck && pnpm lint && pnpm test` → green → `git commit` → tag `m<N>` →
`git push` → `wrangler deploy` → run `scripts/smoke.ts` against the DEPLOYED url →
only then proceed. A milestone without a passing deployed smoke test is NOT done.

---

## §6. Guardrails

1. Green typecheck+lint+tests before every commit. No `--no-verify`, no skipped tests.
2. Commit, tag, push, deploy, smoke-verify per milestone (§5) before the next.
3. Log every non-obvious decision to `docs/DECISIONS.md` (one line, newest at bottom).
4. Blocked >30 min on an external service (Cloudflare API, provider outage, dead model
   slug) → write `docs/BLOCKERS.md` with exact error + attempted fixes → move to the
   next non-dependent task.
5. **Never hardcode model IDs outside `config/`** (single M0 bootstrap exception, removed in M1).
6. **Never invent provider rate limits or model slugs** — verify live (models APIs /
   provider docs); unverifiable → conservative default + `TODO(verify)` + DECISIONS entry.
7. Never commit `secrets/`, `.dev.vars`, or any key material. Add to .gitignore in M0
   before first commit.
8. No paid model may ever be callable unless `allow_paid: true` in lanes.yaml (default false).
   Enforce in code, not convention.
9. pnpm only. Node-only APIs banned in `src/worker/` + `src/do/` (eslint-enforced).
10. Do not weaken auth: every non-health route requires the bearer token.

---

## §7. When done (or cannot proceed)

Write `docs/MORNING_REPORT.md`:

- completed milestones + tags, deployed Worker URL, test/smoke status,
- per-provider live/disabled table, open blockers,
- the three things the human should review first,
- exact `claude-free()` snippet ready to paste into `~/.zshrc`.

---

## §8. Post-v1 backlog (M0–M5 complete; not scheduled)

Logged as they were discovered; each entry cites the DECISIONS.md line that motivated it.

1. ~~**Per-model multimodal capability flag.**~~ **SHIPPED 2026-07-24** — `multimodal_models`
   list on providers (providers.yaml + router.ts); vision models wired as SIMPLE/HARD
   tails. Google is no longer a multimodal single point of failure. See DECISIONS.md.
2. ~~**Media-generation surface.**~~ **PARTIALLY SHIPPED 2026-07-24** — `POST
/v1/images/generations` (OpenAI Images API-compatible) routes `images.chain` (Workers
   AI flux-1-schnell → sdxl-lightning) through the shared ledger; now has a UI consumer
   (`chat/`'s Image mode, same day). Still open: video/music (Veo/Lyria — free-quota-gated
   on AI Studio at ship time), and Gemini image models in the chain once the key has quota
   (the code path exists).
3. **Ollama local lane** — owner opted out 2026-07-23 (SPEC §5 Persona E); revisit only
   on explicit request.
4. **Embeddings** — **SHIPPED 2026-07-24** (was an implicit gap, surfaced by this pass):
   `POST /v1/embeddings` routes `embeddings.chain` (Workers AI bge-m3 → Gemini
   embedding). Vector dims differ per model — clients pin an entry when a vector store
   needs stable dims.
5. **Hosted chat app.** **SHIPPED 2026-07-24** — `chat/`, a standalone Next.js app
   (own package.json, deployed independently to Vercel — https://kompass-chat.vercel.app)
   with bearer-token login, multi-conversation chat (vision, markdown/code rendering,
   served-by/lane provenance), image generation, and web research (tool-use loop against
   two new serverless routes). Required Worker-side CORS + `x-kompass-served-by`/
   `x-kompass-lane` response headers (src/worker/index.ts) so a different origin can call
   the API at all. Agent/Slides intentionally not ported — no filesystem in a hosted
   serverless context; those stay `kompass ui`-only. See DECISIONS.md for the two live-QA
   bugs found and fixed (a flex `align-items:flex-start` overflow needing `max-width:100%`,
   not the usual `min-width:0`; and native `confirm()` dialogs replaced with in-app
   two-step confirmation).
