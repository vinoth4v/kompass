# Kompass v2 — Morning Report

Continues `docs/MORNING_REPORT.md` (v1, M0–M5). This file tracks v2 (M6–M10)
per `BUILD_PLAN_V2.md` §8.

---

## M6 — Context Fit & Budget Awareness

**Status: complete.** Tag `m6`, commit `3082a69`, pushed to `origin/main`.
Deployed: **https://kompass.vinoth4v.workers.dev** (config re-pushed to KV same
run — `kompass config push`, version `2026-07-24T14:24:56.099Z`).

### Test / smoke status

| Check                 | Result                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`      | ✅ green                                                                                                                                      |
| `pnpm lint`           | ✅ green                                                                                                                                      |
| `pnpm test`           | ✅ 136/136 green (21 new in `test/fit.test.ts`, 115 pre-existing unmodified)                                                                  |
| `pnpm smoke:deployed` | ✅ all 5 checks green, incl. a new >60k-token request (routed LONGCTX → `nvidia/nvidia/nemotron-3-ultra-550b-a55b`, 5.5s, answered correctly) |

### What shipped

- `src/worker/fit.ts` (new): byte-length ÷ self-calibrating per-provider ratio
  estimator (seeded 3.6, EWMA α=0.2, isolate-local — no tokeniser, no DO write);
  `checkFit`/`filterChainByFit` drop a chain entry the request structurally
  can't hold (`ctx` and/or `tpm` exceeded) and rank unknown-ctx entries last
  without ever hard-dropping them.
- Wired into `router.ts`'s `routeRequest`, strictly **after** the privacy-guard
  decision and **before** the DO's quota/cooldown `filterChain` call. Skips are
  logged as `skipped-too-large` with the actual `est_in`/`need`/`ctx`/`tpm`
  numbers. Post-response, the real provider's `usage.input_tokens` corrects
  that provider's ratio (both the buffered and the hybrid-live streaming path).
- `escalation.ts` gained a distinct **"fits nothing anywhere"** synthetic
  notice, separate from the existing `HARD_EXHAUSTED_NOTICE` — fires only when
  every attempt across every lane escalated through was `skipped-too-large`,
  names the largest ctx actually configured.
- `dispatcher.ts`'s LONGCTX heuristic threshold is no longer a hardcoded
  `60_000` — it's now `smallestCtx(AGENTIC chain)`, falling back to 60k when no
  AGENTIC entry declares a ctx. With the real config below, that's currently
  **128,000** (`mistral/devstral-medium-latest`).
- `config.ts`: new optional fields — `default_ctx` (provider), `ctx`/`max_out`/
  `tpm` (per `model_limits` entry) — validated (positive numbers) but never
  required. An unmodified v1 config has none of these anywhere, and a CI
  regression test (`test/fit.test.ts`) proves `filterChainByFit` is then a
  provable no-op reorder regardless of request size.
- `config/providers.yaml` populated with live-verified `ctx`/`max_out`/`tpm`
  for every model actually referenced in `lanes.yaml`.
- `scripts/smoke.ts` + `smoke:deployed` (new `package.json` script): a
  ~75k-token request smoke check, per BUILD_PLAN_V2 §5.

### ctx/tpm/max_out: verified live vs. `TODO(verify)`

Full source list and reasoning in `docs/DECISIONS.md` (2026-07-24 entries).
Summary — **every model referenced in `lanes.yaml` has a live-verified `ctx`.**
The gaps are secondary fields with no public source, left honest rather than
invented (guardrail §6.16):

| Provider                   | ctx                                                                                                                                             | max_out                                         | tpm                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OpenRouter (`:free` slugs) | ✅ live, public `/models` API                                                                                                                   | ✅ live (most entries)                          | n/a (request-quota based)                                                                                               |
| Google (Gemini 3.x)        | ✅ live, `ai.google.dev`                                                                                                                        | ✅ live                                         | `TODO(verify)` — Google stopped publishing a static free-tier table                                                     |
| Groq                       | ✅ live, `console.groq.com/docs/models`                                                                                                         | ✅ live                                         | ✅ live — **corrects a standing wrong assumption** (was guessed ~6-12k, real value is 250k-300k)                        |
| Mistral                    | ✅ live for `codestral-2508` (pinned); `TODO(verify)` for the two `-latest` aliases (number itself verified, alias→dated-card mapping inferred) | `TODO(verify)`                                  | `TODO(verify)`                                                                                                          |
| GitHub (`gpt-4.1`)         | ✅ live — the known-bite case, 8000/4000 confirmed                                                                                              | ✅ live                                         | n/a (RPM/RPD based)                                                                                                     |
| NVIDIA Build (11 models)   | ✅ live, `docs.api.nvidia.com`                                                                                                                  | `TODO(verify)` — no published ceiling           | `TODO(verify)` — undocumented adaptive RPM, not TPM                                                                     |
| Cloudflare Workers AI      | ✅ live                                                                                                                                         | `TODO(verify)` — only a default, not a hard cap | n/a (neuron-quota based)                                                                                                |
| SambaNova                  | ✅ live                                                                                                                                         | `TODO(verify)`                                  | n/a — SambaNova publishes tokens/DAY, a different unit than this schema's per-minute `tpm`; deliberately not misapplied |
| HuggingFace                | ✅ live (native ctx)                                                                                                                            | `TODO(verify)`                                  | `TODO(verify)` — undisclosed, load-dependent                                                                            |

Also surfaced (not a `TODO`, a heads-up): `openrouter/poolside/laguna-m.1:free`
is flagged "Discontinuing July 28, 2026" on OpenRouter's own model page — 4
days out at verification time. Still wired; worth a re-probe soon.

### Before / after

- **Oversize/context-overflow rejections:** no production baseline existed
  (v1 never declared a ctx anywhere, so this failure mode was invisible/
  unmeasured — SPEC_V2 §8's stated starting point). Post-M6, the fit filter
  provably prevents them for every model with a declared ctx: a seeded 200k-
  char request in `test/fit.test.ts` shows zero dispatches to an entry whose
  `ctx` the request would exceed, and the github/gpt-4.1 8k case (the specific
  incident that motivated this milestone) is now enforced live.
- **Wasted hops per request:** not separately instrumented yet (that's M7's
  trace store) — the fit filter's contribution is qualitative until M9's bench
  suite or M7's traces can measure it directly on real traffic.

### Auto-demoted models

None — auto-demotion (health/quality-driven, reversible) is an M8 feature.
Nothing in M6 removes a model from a chain; the fit filter's skips are
per-request and stateless.

### Open blockers

None new. `docs/BLOCKERS.md`'s existing entries (all resolved or non-fatal,
see that file) are unrelated to M6.

### Three things to review first

1. **The GitHub `gpt-4.1` modeling choice** (`config/providers.yaml`,
   `ctx: 8000, max_out: 4000`): the real constraint is two _independent_ caps
   (input≤8000, output≤4000), but this schema only supports one combined
   budget. Modeled as the conservative direction (stricter than reality) per
   guardrail §6.16 — worth a second look if `gpt-4.1` ever seems
   under-utilized as a result.
2. **Mistral's two `-latest` aliases** (`mistral-small-latest`,
   `devstral-medium-latest`): the `ctx` values are real numbers from live
   Mistral docs, but the alias→dated-model-card mapping itself is inferred by
   elimination, not confirmed on any public aliases page. Flagged
   `TODO(verify)` in the YAML; low risk (conservative side, both aliases point
   at the newest matching card) but worth a live currency check.
3. **`nvidia/nemotron-3-ultra-550b-a55b`'s declared ctx (262,144, not the
   catalog's advertised 1M):** NVIDIA's NIM reference confirms the 1M window
   requires a non-default deployment flag (`VLLM_ALLOW_LONG_MAX_MODEL_LEN=1`)
   that we don't control or know the state of for this key. If this key's NIM
   deployment does happen to be configured for 1M, this config is needlessly
   conservative on the LONGCTX lane's largest window — safe either way, but
   worth confirming if LONGCTX capacity ever becomes a bottleneck.

### Free lanes vs. native Claude

This build session ran with no `ANTHROPIC_BASE_URL` override present in the
shell environment — i.e. it was built on native Claude, not dogfooded through
Kompass itself (BUILD_PLAN_V2 §7's `claude-free` loop). Unlike v1's report,
this session has no per-task free-lane/native breakdown to log.
