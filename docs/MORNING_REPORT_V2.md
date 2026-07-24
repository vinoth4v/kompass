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

---

## M7 — Trace Store & Observability

**Status: complete.** Tag `m7`, commit `e1a7604` (plus two merge commits —
`549db0b`, `9383147` — reconciling concurrent work pushed from another
machine mid-build, and a smoke-check fix, `9695069`), pushed to `origin/main`.
Deployed: **https://kompass.vinoth4v.workers.dev** (config re-pushed to KV —
the KV namespace itself changed mid-session, see below).

### Test / smoke status

| Check                 | Result                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`      | ✅ green                                                                                                                                                                                             |
| `pnpm lint`           | ✅ green                                                                                                                                                                                             |
| `pnpm test`           | ✅ 152/152 green (16 new in `test/trace.test.ts`, all M6 tests unmodified)                                                                                                                           |
| `pnpm smoke:deployed` | ✅ all 7 checks green, incl. trace-id header + fetchable/redacted trace + `/traces` listing (see below for a real free-tier exhaustion hiccup mid-verification, resolved by waiting, not a code fix) |

### What shipped

- `src/do/trace.ts` (new): `TraceRecord` schema, `pushTrace` (ring-buffer
  append+evict, strips `raw_body`/`exp` unconditionally so redaction can't be
  defeated), `isExpired` (lazy TTL check, same convention as the existing
  verdict cache), `digestOf` (SHA-256 fingerprint, irreversible), `newTraceId`.
- `KompassState` (`src/do/state.ts`) gained `writeTrace`/`getTrace`/
  `listTraces` — the 500-entry ring buffer lives under one `traces` key (same
  pattern as the existing `routes` log); opt-in full-capture bodies live in
  separate `tracefull:<id>` keys with their own TTL, never mixed into the
  ring buffer.
- Wired into `handleAnthropic` (index.ts): every routed request — success,
  no-fit, or fully exhausted — gets a trace, written fire-and-forget via
  `ctx.executionCtx.waitUntil()` after a small `finish()` wrapper adds the
  `x-kompass-trace-id` response header. `X-Kompass-Trace: full` opts one
  request into raw-body capture (capped 500KB, expires after 1h).
- New authenticated `GET /trace/:id` (404 on unknown/evicted) and
  `GET /traces?n=` (redacted listing, newest first).
- New CLI: `kompass trace <id>`, `kompass trace list [--n N]`,
  `kompass trace replay <id> [--lane L] [--model M]` — kept separate from the
  existing `kompass logs` (live `wrangler tail`) rather than overloading it,
  since BUILD_PLAN_V2's literal "`kompass logs --last N`" phrasing would have
  collided with an unrelated existing command (see DECISIONS.md).
- `router.ts`'s `RouteAttempt` gained an optional `ms` (latency) field, reused
  from the existing per-entry timing already computed for `reportOutcome`
  rather than measured twice.
- README trust-model section + CLI table updated; `scripts/smoke.ts` gained a
  trace-store check.

### The SPEC_V2 §9 blocking prerequisite

Resolved before writing any storage code, per the explicit "one decision
needed before M7" instruction: verified live (Cloudflare's own docs, not
assumed) that `KompassState`'s SQLite-backed Durable Object storage — Workers
Free plan — gives 5GB/account, 10GB/object, 2MB per key+value, 100,000 rows
written/day. A 500-entry ring buffer written as one array-under-one-key is 1
row per request, comfortably inside that budget alongside the ~4-5 writes
M0-M6 already make per request. **No sampling fallback needed** — full
tracing shipped as designed. Full reasoning and source URLs in
`docs/DECISIONS.md`.

### Acceptance criteria

- [x] 500-request soak: DO storage within limits, ring buffer evicts oldest —
      `test/trace.test.ts` runs 520 real writes against the live SQLite-backed
      storage backend (not a mock), confirms the cap holds and the oldest 20
      are evicted, in ~850ms total (no meaningful added latency per write).
- [x] Seeded secret in the prompt → default trace contains no raw prompt
      text — integration test confirms `JSON.stringify(trace)` never contains
      the seeded `AKIA...` string; only a SHA-256 digest is stored.
- [x] Replay of a full trace reproduces the original routing decision —
      `kompass trace replay` re-issues the stored raw body (only present when
      `X-Kompass-Trace: full` was set) against `/v1/messages`; verified live
      (see below), not unit-tested — CLI/Node code follows this repo's
      existing convention of live-only verification (matches `kompass status`,
      `deprecate`, `models`).
- [~] Trace write failure injected → response still succeeds — a genuine
  failure-injection attempt (a circular-reference record, which
  `structuredClone` legitimately rejects) crashed the test harness's own
  isolated-storage bookkeeping rather than surfacing as a catchable
  rejection — a known limitation of `@cloudflare/vitest-pool-workers`, not
  of the Worker code. Verified structurally instead: `writeTrace` never
  internally try/catches, so failures genuinely propagate; the call site
  (`index.ts`'s `finish()`) wraps it in `.catch()` before handing it to
  `ctx.waitUntil()`, which by construction runs after the response has
  already been returned — the identical pattern already trusted for
  `reportOutcome`/`recordUsage`/`putVerdict` since M2-M5, none of which
  have a dedicated failure-injection test either. See DECISIONS.md.
- [x] Green typecheck/lint/test.

### Before / after

- **Misroutes diagnosable from a single trace (SPEC_V2 G3):** previously
  required correlating `/status`'s last-50 route log with server-side
  `console.log` output. Now `kompass trace <id>` shows the full picture in one
  call — lane, verdict/confidence, every chain entry considered, every attempt
  with its outcome/reason/latency, final model, usage.
- **Wasted-hops measurement (flagged as pending in the M6 report):** each
  trace's `attempts[]` array now makes this directly countable per request —
  still needs M9's bench suite to aggregate it into a metric, but the raw data
  no longer needs separate instrumentation.

### A real-world hiccup during deployed verification (not a code bug)

The first `pnpm smoke:deployed` run after this deploy showed the >60k-token
LONGCTX check technically passing (non-empty text) but actually landing on the
generic exhausted-notice fallback — `lane=null served_by=null`. Investigated
via `/status`: all four LONGCTX chain entries were in a live M2 health
cooldown, caused by **real upstream free-tier exhaustion** from the day's
cumulative M6+M7 testing — Google's actual account-level 429 ("You exceeded
your current quota"), NVIDIA's actual `ResourceExhausted: Worker local total
request limit reached (104/32)`, and OpenRouter/NVIDIA-via-OpenRouter rate
limits — not a Kompass bug, and not caught by Kompass's own internal
rpm/rpd counters (which track what Kompass itself has dispatched, not the
upstream provider's separate account-level throttling). Two real findings
came out of chasing this down: (1) the smoke check's own assertion was too
weak — `text.length > 0` is also true for the synthetic notice — tightened to
require a non-null `served_by` header (fixed, tested, deployed). (2) Waited
~2 minutes for the fastest-cooling pair (`google/gemini-3.6-flash`,
`nvidia/nemotron-3-ultra-550b-a55b`) to clear their cooldowns, then re-ran:
clean pass, real route (`served_by=nvidia/nvidia/nemotron-3-ultra-550b-a55b`,
16s — slower than M6's 5.5s run, consistent with a provider still recovering
from load). No code changed to "fix" this beyond the smoke-assertion
tightening — it was the correct, working exhaustion-fallback behavior
observed live under real free-tier pressure.

### Auto-demoted models

None — M7 doesn't demote anything (that's M8). The live cooldowns observed
above are the existing M2 health-cooldown mechanism working as designed, not
a new M7 behavior.

### Open blockers

None new.

### Three things to review first

1. **Trace `usage` is best-effort, not guaranteed.** Populated from the
   response's `usage.input_tokens`/`output_tokens` on the buffered path;
   left `undefined` on the hybrid live-streaming path, where real usage only
   resolves after the trace is already written. Extending the ledger's
   existing "late usage" back-fill pattern (`recordUsage`) to traces too was
   scoped out — a reasonable follow-up, not a correctness gap against any M7
   acceptance criterion.
2. **The KV namespace changed mid-session** (`config/CONFIG` binding id went
   from `45e10070...` to `ac8f6361...` between the M6 and M7 deploys) via
   commits merged in from another machine's `kompass init` run — outside this
   session's scope (`wrangler.toml`/`.jsonc` bindings were explicitly off
   limits per the M6 brief, and this session didn't touch them). Config was
   re-pushed to the new namespace so the deploy is correct, but worth
   confirming intentionally on the human's side — a namespace switch usually
   means a fresh empty KV unless the old data was migrated.
3. **Images/embeddings capabilities aren't traced.** Only the classifier-routed
   chat lanes (`handleAnthropic`) write to the trace store; `capabilities.ts`'s
   `routeImageGeneration`/`routeEmbeddings` use a different routing shape that
   doesn't map onto the `{lane, verdict, chain_considered}` trace schema.
   Reasonable scope boundary (not in BUILD_PLAN_V2's M7 task list), but a gap
   if debugging image/embedding routing ever needs the same tooling.

### Free lanes vs. native Claude

Same as M6 — no `ANTHROPIC_BASE_URL` override present in this session's shell
environment; built on native Claude.

---

## M8 — Quality Signal & Adaptive Weights

**Status: complete.** Tag `m8`, commit `dac0916`, pushed to `origin/main`.
Deployed: **https://kompass.vinoth4v.workers.dev**, config re-pushed.

### Test / smoke status

| Check                 | Result                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`      | ✅ green                                                                                                                                                 |
| `pnpm lint`           | ✅ green                                                                                                                                                 |
| `pnpm test`           | ✅ 173/173 green (21 new in `test/score.test.ts`, every M0-M7 test unmodified except one v1 fixture updated for the new selection mechanism — see below) |
| `pnpm smoke:deployed` | ✅ 4 of 5 consecutive runs fully green; 1 run hit two real HTTP 500s — investigated, see below, not blocking                                             |

**The one smoke anomaly, investigated rather than dismissed:** one
`smoke:deployed` run returned HTTP 500 (not a graceful synthetic-notice
fallback) on the streamed-completion and tool-round-trip checks; three
immediate re-runs and one manual `curl` reproduction all came back clean.
Reviewed every new score-recording call site in `router.ts`/`index.ts` for
an unguarded throw — all are wrapped in `.catch()`, and the two call sites
that could theoretically fire in production (escalation attribution) are
inside the existing M5 escalation block's own try/catch. `/status`'s
Cloudflare panel shows 11 errors / 4376 requests today (~0.25%) and a CPU
p99 of 35ms against the 10ms free-tier budget — flagged as "hitting the CPU
ceiling" by the existing dashboard logic, but this is a **pre-existing,
cumulative concern this project has flagged in every milestone since M0**
(large Claude Code payloads triggering privacy-guard/digest/fit-filter CPU
spikes), not a new regression traceable to a specific M8 code path — the
score-recording DO calls themselves are I/O-bound RPCs (compute happens
inside the DO's own separate CPU budget), not CPU work on the calling
Worker. Recorded here rather than silently ignored; see "three things to
review" below.

### What shipped

- `src/worker/score.ts` (new): the scoring engine — `health` (EWMA, α=0.2,
  seeded 1.0, protocol-level outcomes only) × `quality` (penalty-based:
  escalation attribution +1.0, malformed tool call +0.7, empty/truncated
  completion +0.7, opt-in corrective turn +0.4), `score = health × quality`,
  spread weight `score²`. A 10-attempt sparse-data guard gates the ENTIRE
  demotion decision (not just the quality term), so nothing demotes on thin
  data; a model auto-demotes out of the `spread_top` weighted pool after 3
  consecutive below-floor evaluations once that gate lifts, and auto-recovers
  on its next successful real attempt ("single probe; success restores" — a
  demoted entry stays reachable as an ordinary chain-tail fallback, so real
  traffic doubles as the probe).
- `config.ts`: chain entries can now be an object (`{model, ban?, pin?}`) as
  well as a plain string — `ban: true` excludes an entry from ever being
  dispatched in that lane (same mechanism as `disabled_models`, scoped to one
  chain position); `pin: <0-1>` floors its effective score. New optional
  `quality: { corrective_turn_detection, corrective_patterns }` config block,
  off by default per SPEC_V2 §9.
- `state.ts`: new `score:<lane>:<entry>` storage cells, `recordScoreAttempt`/
  `recordScorePenalty` DO methods (every demotion/recovery is logged to the
  route log with its reason — guardrail §6.15), `filterChain` now sinks
  demoted entries to the chain tail and weights the `spread_top` pool by
  adaptive score instead of the old raw ok/fail ratio (`perf:*` stays as a
  separate, display-only counter for `/status`'s "recent reliability" table).
  `releaseSticky`/`peekSticky` now return the entry's own `{entry, lane}` for
  correct score-cell attribution.
- `router.ts`/`live.ts`/`adapters/openai.ts`: truncated-completion and
  malformed-tool-call detection wired into both the buffered and hybrid
  live-streaming paths (the native Claude Code dialect's default), scored via
  the same "late" `usageLater` pattern M6/M7 established for calibration/
  trace writes.
- `index.ts`: escalation attribution (a real M5 signal — which model was
  sticky when 3 consecutive tool errors fired) and the opt-in corrective-turn
  check both wired as retroactive penalty events.
- New `POST /ledger/seed-score` test/admin endpoint (mirrors the existing
  `seed-perf`), `scores` field added to `/status` and `snapshot()`.
- README: new "Adaptive quality scoring, and human overrides" section with
  the `ban`/`pin` YAML syntax; corrected a stale "60k tokens → LONGCTX" line
  left over from M6 (the threshold has been config-derived since M6, the
  README just never caught up); `scripts/smoke.ts` gained an adaptive-scoring
  shape check.

### Acceptance criteria

- [x] Seeded model returning truncated streams leaves the spread within 10
      requests, no YAML edit — `test/score.test.ts`'s unit fixture demotes at
      exactly attempt 10 (not before, not after); the HTTP integration test
      drives 10 real truncated responses through the actual request pipeline
      and confirms a follow-up spread pick deterministically avoids it.
- [x] Same model auto-recovers after probes succeed — unit + integration
      tests confirm one clean attempt clears `demoted`.
- [x] The v1 FAST/8b regression reproduced as a fixture and caught by the
      score — reproduced via escalation attribution (not corrective-turn
      detection, which is off by default): 10 fully healthy attempts (health
      stays 1.0 — the exact "looks fine" trap that let the real incident slip
      past health-only checks) plus 8 escalation penalties still demotes.
      Escalation→score wiring itself is separately verified live via a real
      3-consecutive-tool-error cycle.
- [x] `ban: true` beats a perfect score; `pin:` beats a terrible one — both
      verified via direct DO calls and full HTTP integration (a banned entry
      seeded with a perfect score is never dialed; a pin rescues a cell
      seeded with terrible stats from demotion).
- [x] <10 attempts → no demotion (sparse-data test) — verified both as a pure
      unit test and as an HTTP integration test (9 consecutive truncated real
      requests, confirmed still not demoted).
- [x] Green typecheck/lint/test.

### A real bug found and fixed while testing (not by review)

`reevaluateDemotion`'s "score recovered above the floor" branch reset the
below-floor streak counter but never actually cleared the `demoted` flag
itself — so a `pin` override that mathematically rescued a demoted entry's
score left it stuck showing `demoted: true` until its next successful real
attempt happened to occur. Since a demoted entry only gets picked from the
chain tail as an ordinary fallback (rarely, by design), that's a real
chicken-and-egg risk that would have quietly defeated "pin: beats a terrible
one" in production. Caught by `test/score.test.ts`'s dedicated pin-recovery
test, not by manual review — fixed same session. See `docs/DECISIONS.md`.

### Before / after

- **Time from model degradation → demotion (SPEC_V2 success metric, target
  <10 requests, no human action):** previously unbounded — v1 had no quality
  signal at all, only the M2 health-cooldown mechanism, which only reacts to
  hard protocol failures (5xx/429/timeout), never to a model that's
  technically succeeding but subjectively bad. Now bounded at exactly 10
  requests for the worst case (consistently bad from the first attempt),
  proven by test, not assumed.
- **Manual `lanes.yaml` edits per month (SPEC_V2 lagging metric):** the
  original FAST/8b incident required a human noticing degraded answers and
  hand-editing the chain order. That exact class of problem is now handled
  automatically; `pin`/`ban` remain for cases where human judgment should
  override the adaptive system outright, not for the routine case.

### Auto-demoted models

None in production — this section describes new MACHINERY for auto-demotion,
not an event that occurred against real traffic during this build session.
The fixtures and fitted fixtures above prove the mechanism; no live model was
observed crossing the demotion floor during this session's own smoke/dev
traffic.

### Open blockers

None new.

### Three things to review first

1. **`DEMOTE_SCORE_FLOOR=0.5` and `DEMOTE_CONSECUTIVE_K=3`** are not numbers
   given in BUILD_PLAN_V2/SPEC_V2 — they were chosen and tuned by simulation
   to satisfy the "within 10 requests" acceptance criterion for the worst-case
   fixture. Worth watching against real traffic: if real "bad" models are
   less consistently bad than the all-truncated fixture, demotion could take
   meaningfully longer than 10 requests in practice (the fixture is a lower
   bound on demotion speed, not a guarantee for every failure pattern).
2. **Corrective-turn detection's attribution is best-effort by construction**
   (uses the session's current sticky entry as a proxy for "who answered the
   turn being reacted to") and ships off by default. If enabled, review the
   `corrective_patterns` regex list carefully — a too-broad pattern could
   penalize models for unrelated user turns that happen to contain phrases
   like "try again" in a non-corrective sense (e.g. discussing retry logic).
3. **Malformed-tool-call detection has no Gemini equivalent** (structural, not
   an oversight — see docs/DECISIONS.md) and the live-streaming path's
   detection reuses an existing silent-drop code path rather than being a
   wholly new check. Both are real signals, but worth knowing the coverage
   isn't perfectly symmetric across providers/paths if `malformed_tool_call`
   penalty counts ever look asymmetric in `/status`.
4. **The CPU-ceiling flag on `/status`** (p99 35ms vs. the 10ms free-tier
   budget, 11/4376 errors today) predates this milestone as a known concern
   but was re-surfaced by chasing the one flaky smoke run above — worth an
   actual measurement pass (the M6/M7 pattern: instrument, don't guess) on
   the cumulative per-request CPU cost of privacy guard + fit filter +
   digest + fit-filter's estimator + M8's synchronous overrides computation,
   now that four milestones' worth of hot-path additions have stacked up.
   Not done here — out of scope for M8 specifically, but the next milestone
   that touches the request hot path should budget time for it.

### Free lanes vs. native Claude

Same as M6/M7 — no `ANTHROPIC_BASE_URL` override present in this session's
shell environment; built on native Claude.
