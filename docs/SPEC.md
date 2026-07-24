# Kompass — Classifier-Routed Free-Model Gateway for Claude Code

**Version:** 0.2 draft · **Date:** 23 July 2026 · **Author:** Vinoth Kannan
**Working name:** Kompass (alternatives: `ccflow`, `freeroute`). **Cloudflare Worker (single-user, free tier) as primary deployment target**; same codebase runs locally via `wrangler dev`. MIT license.

---

## 1. Problem Statement

Developers using Claude Code on a Pro subscription hit 5-hour/weekly usage limits during heavy agentic sessions. Free model tiers (OpenRouter `:free`, NVIDIA Build, Google AI Studio, Groq, Cerebras) collectively offer enough capacity to keep coding at zero cost — but they are fragmented across incompatible APIs (Anthropic vs OpenAI vs Gemini formats), have volatile rosters and per-provider rate limits, and **no existing tool routes between them by task complexity**. OpenRouter's `openrouter/free` switches by _availability_ only; `openrouter/auto` routes to _paid_ models; claude-code-router routes by static rules, not semantic task understanding. The result: developers either burn premium quota on trivial tasks or manually juggle keys and model IDs.

## 2. Goals

1. **One endpoint for Claude Code, from every machine.** `ANTHROPIC_BASE_URL=https://kompass.<you>.workers.dev` — zero changes to Claude Code itself; identical behavior from any laptop, desktop, or remote box.
2. **Complexity-aware routing at $0 infrastructure and $0 models.** ≥85% of tasks land on an appropriate-tier free model on first attempt (measured by no-escalation rate); Worker + Durable Object stay within Cloudflare free tier (100k req/day).
3. **Continuous coding.** Survive any single provider's rate limit or roster change via fallback chains; <1% of requests fail with no model available.
4. **Extensible in <5 minutes.** Adding a new provider or model = editing one YAML block, no code.
5. **Classifier overhead <400ms** p50 added latency on routed requests (0ms on cache hits and heuristic short-circuits).

## 3. Non-Goals

- **Not a paid-model cost optimizer.** All lanes default to $0 models; paid models are opt-in only (`allow_paid: true`). Rationale: money-routing is OpenRouter `auto`'s job.
- **No Claude Pro OAuth proxying.** Anthropic's Feb 2026 terms prohibit third-party use of subscription OAuth. Kompass never touches subscription auth; the user switches to native `claude` manually (or via the companion watcher, P2).
- **No multi-tenant SaaS in v1.** Kompass deploys as _your personal_ Worker under _your_ Cloudflare account; one user, your keys as Worker secrets, gated by a bearer token. Rationale: no auth/billing complexity, keys never shared with a third-party operator (Cloudflare hosts, but only you can invoke).
- **No fine-tuned custom classifier in v1.** We call an existing fast free reasoning model; training a RouteLLM-style classifier is P2.
- **No GUI beyond a read-only status page in v1.** Config is YAML; dashboard editing is P1.
- **No media generation (images/video/music) in v1.** Kompass speaks chat dialects; generation APIs return binary media. The free keys already unlock those models directly (AI Studio imagen/veo/lyria/gemini-image, Workers AI flux/SDXL) — a `/v1/images` surface is P2 (BUILD_PLAN §8.2).

## 4. Architecture

```text
 Claude Code ──/v1/messages──▶ ┌────────────────────────────────┐
                               │            KOMPASS             │
                               │                                │
                               │  1 INGRESS  Anthropic-format   │
                               │      parse + session tracker   │
                               │             │                  │
                               │  2 PRE-FILTER (0ms heuristics) │
                               │      tokens<1k & no tools→FAST │
                               │      ctx>60k→LONG · cache hit  │
                               │             │ (else)           │
                               │  3 DISPATCHER 🧠               │
                               │      fast reasoning model      │
                               │      (Gemini Flash-Lite, free) │
                               │      → {SIMPLE|AGENTIC|HARD|   │
                               │         LONGCTX} + confidence  │
                               │             │                  │
                               │  4 LANE TABLE (YAML, hot-reload)│
                               │      lane → [model chain]      │
                               │             │                  │
                               │  5 QUOTA LEDGER                │
                               │      RPM/RPD per provider —    │
                               │      skip exhausted upfront    │
                               │             │                  │
                               │  6 ADAPTERS                    │
                               │      Anthropic⇄OpenAI⇄Gemini   │
                               │      streaming + tool-call     │
                               │      normalization             │
                               └───────┬────────┬───────┬───────┘
                                       ▼        ▼       ▼
                                 OpenRouter  NVIDIA   Google AI      + any
                                  (:free)    Build    Studio         OpenAI-
                                 Laguna S    GLM-4.7  Gemini 3      compatible
                                 Qwen3-Coder DS-V3.2  Flash/Pro      endpoint
```

**Deployment & state (Worker-first):** Kompass runs as a single Cloudflare Worker (Hono + TypeScript). All shared state — **quota ledger, session stickiness map, model-health cooldowns, classifier verdict cache** — lives in one **Durable Object**, giving strongly-consistent counters across every machine you code from: your MacBook and your work laptop draw down the _same_ OpenRouter 1,000/day ledger. Provider API keys are Worker **secrets** (`wrangler secret put`); the lane table YAML compiles to JSON in **Workers KV** with an authenticated `POST /config` for hot-reload from the CLI. Ingress is gated by your own bearer token (the value you set as `ANTHROPIC_AUTH_TOKEN`) — reject everything else, so the Worker is never an open proxy. Streaming SSE passthrough is native to Workers fetch. The identical codebase runs locally via `wrangler dev` (in-memory state shim) for development and as an offline fallback. Design constraint: **no Node-only APIs** (fs, net) in core — the state store is a pluggable interface (`MemoryStore | DurableObjectStore`) so a later self-hosted SQLite target (P2, for the Tailscale/privacy crowd) is a new adapter, not a rewrite.

**The Dispatcher is the core innovation:** a fast free reasoning model (default `gemini-flash-lite`, direct Google AI Studio key, ~1,500 req/day free) receives a compressed task digest (last user message + tool list + file count, max 500 tokens) and returns one JSON token-cheap verdict: `{"lane":"AGENTIC","confidence":0.87}`. Heuristics short-circuit ~50% of calls so the classifier never becomes the bottleneck; low-confidence verdicts (<0.6) default to the AGENTIC lane (safe middle).

**Session stickiness:** once a lane is chosen for a Claude Code session, subsequent turns stay on the same model unless (a) escalation triggers or (b) the user sends `/model`. Prevents context-coherence loss from mid-task model swaps.

**Failure escalation:** the ingress tracks tool-result errors per session; ≥3 consecutive failed iterations on one lane → escalate SIMPLE→AGENTIC→HARD; at HARD-exhausted, return a synthetic assistant message: _"Free lanes exhausted for this task — consider switching to native Claude (`claude`)."_

### Default lane table (ships in `kompass.yaml`)

| Lane    | Chain (primary → fallbacks)                                                                  | Why                                                                          |
| ------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| FAST    | `google/gemini-flash-lite` → `groq/llama-3.3-70b` → `openrouter/qwen3-coder:free`            | speed; background tasks; `ANTHROPIC_SMALL_FAST_MODEL` traffic auto-maps here |
| SIMPLE  | `openrouter/qwen3-coder:free` → `nvidia/glm-4.7` → FAST chain                                | cheap correct code                                                           |
| AGENTIC | `openrouter/laguna-s-2.1:free` → `nvidia/qwen3-coder-480b` → `openrouter/laguna-xs-2.1:free` | best free tool-calling agents (Terminal-Bench 70.2%)                         |
| HARD    | `nvidia/deepseek-v3.2` → `google/gemini-3-pro` (free 100/day) → AGENTIC chain                | max free reasoning                                                           |
| LONGCTX | `google/gemini-flash` (1M) → `openrouter/qwen3-coder:free` (1M)                              | ctx > 60k tokens                                                             |

> **This table is the original design sketch.** The live, continuously-verified lane
> table is `config/lanes.yaml` (hot-reloaded via `kompass config push`) — model slugs
> above have since been replaced as rosters churned (e.g. `qwen3-coder:free` dead-listed
> before M0; design/creative additions 2026-07-23). Every add/remove is probed for
> tool-calling first and logged in `docs/DECISIONS.md`.

## 5. User Stories (by persona, priority order)

_Status legend: ✅ shipped & verified live · 🔲 not built. Updated 2026-07-23 after the
v1 build-out (M0–M5), the reliability redesign, the multi-dialect ingress and the UI workbench._

**Persona A — Pro-subscriber developer (primary):**

- ✅ As a developer who constantly switches machines, I want one cloud endpoint with shared quota state so that starting on my MacBook and continuing on my work laptop uses the same rate-limit ledger and the same session's model — with nothing installed locally except two env vars.
- ✅ As a Claude Pro developer who hit my 5-hour limit mid-feature, I want to type `claude-free` and continue the same repo work on free models so that my flow never stops.
- ✅ As a Pro developer, I want trivial tasks (renames, docstrings, boilerplate) automatically kept off my premium quota so that Claude quota is preserved for hard problems.
- ✅ As a Pro developer, I want a synthetic in-chat notice when free lanes can't solve my task so that I know when switching back to native Claude is worth it.
- ✅ As a developer running long agentic sessions, I want provider failures — including mid-generation deaths and empty responses — to be completely invisible to my editor so that I never have to type `--continue` or retry manually. _(Delivered via the buffer-then-emit redesign: Kompass always resolves the complete answer server-side, cascading through every model in every lane, before writing a byte to the client. Trade-off accepted: responses arrive as a burst, not token-by-token.)_

**Persona B — Zero-budget developer:**

- ✅ As a developer with no AI budget, I want one command that pools free quota across many providers (OpenRouter, NVIDIA, Google, Groq, Mistral, GitHub Models, Cloudflare AI, SambaNova, Cohere, Hugging Face) so that rate limits on one provider never block me.
- ✅ As a zero-budget developer, I want the router to refuse paid models by default so that I can never be surprise-billed. _(`allow_paid: false` enforced at both config-validation and request time.)_
- ✅ As a zero-budget developer, I want to see remaining daily quota per provider (`kompass status`, dashboard, UI sidebar) so that I can plan heavy sessions.
- ✅ As a zero-budget developer, I want Kompass to spread load across similarly-good models (`spread_top` + success-rate weighting) so that I don't exhaust my best model's daily quota by lunchtime.

**Persona C — Multi-editor developer:**

- ✅ As a Cursor/Cline/Roo Code/Continue/Aider user, I want to point my editor's OpenAI-compatible settings at Kompass (`/v1/chat/completions`) so that every tool I use shares one free-model gateway and one quota pool.
- ✅ As a Codex CLI user, I want Kompass to speak the OpenAI Responses API (`/v1/responses`) so that Codex works even though it dropped Chat Completions support in Feb 2026.
- ✅ As a multi-editor user, I want model names `kompass` (auto-route) and `kompass-fast/-simple/-agentic/-hard/-longctx` (pin a lane) so that I control routing from any client's model picker without custom headers.
- ✅ As a developer without any coding CLI installed, I want a local web workbench (`kompass ui`) with chat, an agentic coding mode (approval-gated bash/file tools), a web-research mode, and a PowerPoint generator so that the gateway is useful beyond editor integrations.

**Persona D — Tinkerer / model evaluator:**

- ✅ As a tinkerer, I want to add a brand-new free model by pasting 4 lines of YAML (then `kompass config push` — no redeploy) so that I can try releases the day they drop.
- ✅ As a tinkerer, I want a daily scheduled discovery report (`/discovery`, `kompass discovery`) diffing each provider's live roster against my config so that I hear about new free models without polling — detect-only by design, never auto-added (three roster-listed models proved broken in practice).
- ✅ As a tinkerer, I want a first-class deprecation registry (`kompass deprecate old --replaced-by new`) so that superseded models are rewritten to their replacement at every config push and can never silently go live again.
- ✅ As a tinkerer, I want `kompass bench` to run my 10-task suite across lanes so that my lane table reflects _my_ repos, not public benchmarks.
- ✅ As a tinkerer, I want per-request logs and a live dashboard showing lane, classifier verdict, model, latency, token usage, fallback hops, per-model reliability, and Kompass's own Cloudflare free-tier utilization so that I can debug misroutes and capacity.

**Persona E — Privacy-conscious enterprise developer:**

- ✅ As an enterprise developer, I want a privacy guard that blocks requests containing configured path globs / secret patterns from providers flagged `trains_on_data: true` so that work code never leaks into training sets.
- 🔲 As an enterprise developer, I want an optional local lane (Ollama) so that sensitive repos never leave my machine. _(Deliberately not built — owner opted out 2026-07-23.)_

**Edge cases (all handled and regression-tested):** classifier rate-limited or returning garbage → heuristics (fallback classifiers released to lane work 2026-07-24) — never blocks; provider 200-with-empty-content or malformed body (null body, missing `choices`, tool_call without `function`) → treated as failure, falls through the chain invisibly; mid-generation provider death → invisible (response was buffered); every model in every lane exhausted → cross-lane cascade first, then a synthetic in-chat notice (never a raw protocol error); per-model 10-min health cooldown + stickiness release on failure.

## 6. Requirements

**P0 — Must have (v1 cannot ship without):**

1. Anthropic `/v1/messages` ingress incl. **streaming (SSE)** and **tool-call round-trips**, verified against real Claude Code sessions. _(AC: a 20-turn agentic session with file edits + bash tools completes on the AGENTIC lane.)_
2. **Cloudflare Worker deployment** with bearer-token auth gate and keys as Worker secrets. _(AC: `wrangler deploy` → session works from two different machines against the same URL; requests without the token get 401; free-tier request budget not exceeded in a full coding day.)_
3. Adapters: Anthropic⇄OpenAI-chat and Anthropic⇄Gemini `generateContent`, both directions, with tool-schema translation. _(AC: identical toy tool-call task passes on one model per adapter.)_
4. Provider registry + lane table in KV with authenticated hot-reload endpoint. _(AC: `kompass config push` → next request uses new chain, no redeploy.)_
5. Ordered fallback on 429/5xx/timeout with per-model health cooldown, state in the Durable Object. _(AC: kill primary provider mid-session → request succeeds on fallback, logged.)_
6. **Durable Object quota ledger**: RPM/RPD counters per provider key, shared across all clients, pre-emptive skip when exhausted. _(AC: burn 50/50 OpenRouter daily from machine A → machine B's very first request routes to NVIDIA without a single 429.)_
7. Dispatcher classifier with heuristic pre-filter, JSON-verdict parsing, confidence fallback, verdict cache in the DO. _(AC: p50 added latency <400ms incl. Worker hop; heuristic short-circuit rate logged.)_
8. `kompass` CLI (`deploy|status|logs|config push`) wrapping wrangler + the Worker's status API, plus the `claude-free` shell function in install docs.

**P1 — Should have:** 8. Privacy guard (glob + regex blocklist per provider flag). 9. Failure-based lane escalation (the ≥3-iterations rule). 10. Read-only web status page (lanes, quotas, last 50 routes). 11. `kompass bench` personal leaderboard harness. 12. Session stickiness override via `/model` passthrough.

**P2 — Future:** 13. Quota-watcher companion: poll `ccusage`/`/usage`, notify when Pro quota <15% ("switch to claude-free"), optional auto-profile flip. 14. Trained local classifier (RouteLLM-style) replacing the API dispatcher. 15. Ollama local lane; multi-machine shared ledger; plugin SDK for adapters.

## 7. Success Metrics

- **Leading:** first-attempt lane acceptance ≥85% (no escalation); added p50 latency <400ms; free-pool availability ≥99% (some model answered); setup-to-first-response <10 min.
- **Lagging (30 days):** ≥60% of the user's total coding requests served at $0; Pro-quota exhaustion incidents ↓ ≥50%; ≥1 community-contributed provider YAML (extensibility proof).

## 8. Open Questions

- **[engineering, blocking]** Cloudflare free-tier fit for agentic streaming: Workers free tier limits CPU time per request (~~10ms CPU, wall-clock unlimited for streaming passthrough) and Durable Objects have their own free quota — verify at developers.cloudflare.com that a heavy Claude Code day (2–5k requests, long SSE streams) fits, and define the paid-tier threshold (~~$5/mo Workers Paid) as the fallback plan.
- **[engineering, blocking]** Which Gemini free model is the classifier default in July 2026 — verify current Flash-Lite model ID, RPM/RPD, and JSON-mode support at ai.google.dev before M1.
- **[engineering, blocking]** OpenRouter Anthropic-native endpoint vs OpenAI endpoint for `:free` models — test tool-call streaming reliability on both; pick per-provider in registry.
- **[engineering]** NVIDIA Build 40 RPM: per-key or per-model? Determines whether NVIDIA can hold two lanes simultaneously.
- **[engineering]** Privacy guard on a Worker: request bodies transit Cloudflare — is that acceptable for the enterprise persona, or does that persona require the P2 self-hosted store adapter from day one? Document the trust model in the README.
- **[product]** Should HARD-lane exhaustion auto-suggest the paid Z.ai GLM Coding Plan, or stay strictly free-only messaging?
- **[legal/user]** Poolside free endpoints train on inputs — default `trains_on_data: true` + privacy-guard on, or off with a warning?

## 9. Timeline / Milestones (Claude Code build order)

- **M0** Scaffold: TypeScript + Hono on Workers (wrangler), bearer-auth ingress, passthrough to one hardcoded OpenRouter model; streaming works in Claude Code against the deployed `workers.dev` URL **from two machines**. _(guardrail: green typecheck+lint+tests before M1)_
- **M1** Adapters (OpenAI + Gemini) + registry/lane table in KV + `config push` hot-reload.
- **M2** Durable Object: quota ledger + fallback chains + health cooldowns + session stickiness.
- **M3** Dispatcher classifier + heuristics + verdict cache + confidence fallback.
- **M4** `kompass` CLI + status page + install docs (`claude-free` function, wrangler secrets guide).
- **M5** P1 set: privacy guard, escalation, bench harness.
- Each milestone: commit, tag, `wrangler deploy`, verify a live Claude Code smoke session against the deployed Worker before proceeding. Never hardcode model IDs outside the registry. No Node-only APIs in core. Log decisions to docs/DECISIONS.md.

## 10. Prior Art & Positioning

| Tool                         | Has                                        | Lacks (Kompass's gap)                                    |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| claude-code-router (36k★)    | static rules, fallback, custom-router hook | semantic classifier, quota ledger, Gemini-native adapter |
| OpenRouter `openrouter/free` | availability auto-switch                   | complexity routing; can't pool NVIDIA/Google keys        |
| LiteLLM proxy                | adapters, fallbacks, budgets               | task-complexity routing, free-tier quota ledger          |
| RouteLLM                     | trained complexity routing                 | not a Claude Code gateway; paid-vs-cheap framing         |

Kompass = the intersection: **Claude Code-native ingress + semantic free-lane routing + multi-key free-quota pooling.** If claude-code-router ships a classifier first, pivot to building Kompass's dispatcher + ledger as a CCR `CUSTOM_ROUTER_PATH` plugin instead of a standalone daemon (parking-lot decision, revisit at M2).
