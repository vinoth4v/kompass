# Kompass — BUILD_PLAN_V2.md

Autonomous build plan for Claude Code. Read together with `docs/SPEC_V2.md`.
Continues the v1 tag sequence: milestones **M6 → M10**, tags `m6`–`m10`, in strict order.
**All v1 guardrails (`BUILD_PLAN.md` §6) remain in force.** §6 below adds to them; it does not replace them.

---

## §1. Goal

Kompass v1 routes across free models. Kompass v2 makes each routing decision **fit-aware, quality-aware, and explainable** — without adding a paid dependency, a tokeniser, or a model call to the hot path.

**Success =** a real Claude Code session with a 90k-token context completes with zero wasted hops; a deliberately degraded model removes itself from rotation mid-session with no human edit; and every route in that session is reconstructable from `kompass trace`.

---

## §2. Prerequisites

Nothing new from the human. v1's `secrets/.secrets.json`, `CLOUDFLARE_API_TOKEN`, Node 22 + pnpm, and a deployed `workers.dev` Worker are the starting state.

**One decision needed before M7:** confirm Durable Object storage limits are adequate for a 500-entry trace ring buffer (SPEC_V2 §9). If not, M7 ships sampled tracing (1-in-N + always-on-failure) instead of full tracing. Write the answer to `docs/DECISIONS.md` either way.

---

## §3. Stack

Unchanged from v1 §3. TypeScript strict · Hono · Workers · wrangler v4+ · DO behind `StateStore` · YAML→KV config · vitest + `@cloudflare/vitest-pool-workers` · pnpm only · no Node APIs in `src/worker/` or `src/do/`.

New files only — no rewrites:

```
src/worker/fit.ts        estimator + fit filter        (M6)
src/worker/score.ts      health × quality → weights    (M8)
src/do/trace.ts          ring buffer + redaction       (M7)
src/cli/bench.ts         task runner + grading         (M9)
src/cli/trace.ts         trace / replay subcommands    (M7)
test/tasks/*.md          graded bench suite            (M9)
```

---

## §4. Milestones

### M6 — Context Fit & Budget Awareness

**Why first:** every other v2 feature is an optimisation. This one stops active waste — oversize rejections consume RPD on providers that never had a chance of answering.

**Tasks:**
- Extend `providers.yaml`: optional `default_ctx` per provider; optional `ctx`, `max_out` per entry in `model_limits`; optional `tpm` in `limits`. Every field optional, every absence defaulted — a v1 config must boot unchanged.
- Populate real values. **Verify live per guardrail §6.6** — do not invent context windows. Unverifiable → conservative value + `TODO(verify)` + `DECISIONS.md` entry. Start with the ones already known to bite: `github/openai/gpt-4.1` (8k request cap), groq TPM (6–12k).
- Capture request size **once** at ingress from the raw body length. Do not `JSON.stringify` the parsed body to measure it — that's a second full serialisation on the CPU budget.
- `src/worker/fit.ts`: `est_in = bytes / ratio[provider]`, `need = est_in + max_out + 10%`. Keep a chain entry if `need <= ctx` and `est_in <= tpm`. Unknown `ctx` → keep, but rank last.
- Ratio calibration: EWMA per provider, corrected from each response's `usage.prompt_tokens`. Seed 3.6.
- Wire the filter **after** the privacy guard, **before** the quota ledger. Log skips as `skipped-too-large` with the actual numbers.
- LONGCTX heuristic threshold becomes derived (smallest `ctx` in the AGENTIC chain) with 60k as the fallback constant.
- No-fit terminal path: synthetic assistant message naming the largest available window.

**Acceptance:**
- [ ] Seeded 200k-char request: zero dispatches to models with `ctx < need`; skip reasons show the numbers
- [ ] v1 config (no new fields) boots and produces byte-identical routing decisions — regression test
- [ ] Estimator within 15% of `usage.prompt_tokens` after 50 real requests, per provider
- [ ] Fit filter adds <1ms CPU on a 400KB body — measured, not assumed
- [ ] Privacy guard still wins: a smaller non-training model is preferred over a bigger training one
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green

---

### M7 — Trace Store & Observability

**Why second:** M8's quality scoring needs per-request records to exist. Build the substrate before the consumer.

**Tasks:**
- Trace schema: `{ id, session, ts, lane, verdict, confidence, est_in, chain_considered, attempts[{model, outcome, hop_reason, latency_ms}], final_model, usage }`.
- Storage: **DO ring buffer**, default 500 entries, oldest evicted. Not KV — free-tier KV is ~1k writes/day and a heavy session exceeds that. (If §2's check says otherwise, sample instead.)
- All trace writes via `ctx.waitUntil`. A trace failure must never affect a response.
- **Redaction is the default.** Metadata + a truncated/hashed digest only. Never raw prompt text.
- Opt-in full capture: `X-Kompass-Trace: full` header or per-session flag, TTL-bounded (1h default), documented in the README's trust-model note.
- Authenticated `GET /trace/:id` and `GET /traces?n=`; `kompass trace <id>`, `kompass logs --last N`.
- `kompass replay <id> [--lane L] [--model M]` — re-issues a stored request against a different route. Requires a full-capture trace; fails with a clear message on a redacted one.

**Acceptance:**
- [ ] 500-request soak: DO storage within limits, ring buffer evicts oldest, p50 latency unchanged
- [ ] Test with a seeded secret in the prompt: default trace contains no raw prompt text
- [ ] Replay of a full trace reproduces the original routing decision
- [ ] Trace write failure injected → response still succeeds
- [ ] Green typecheck/lint/test

---

### M8 — Quality Signal & Adaptive Weights

**Tasks:**
- Emit quality events from existing signals: escalation attributed to the model that triggered it, malformed tool call, empty/truncated stream. Add corrective-turn detection **behind a config flag, default off** (SPEC_V2 §9 — it may be too noisy to trust).
- `src/worker/score.ts`: per-`(model, lane)` EWMA. `score = health × quality`, spread weight `score²`.
- Sparse-data guard: <10 attempts → health only, no quality penalty, no demotion.
- Auto-demote: below floor for K consecutive attempts → drop out of the spread window (stays in the chain tail, still reachable). Logged to the route log with the reason.
- Auto-recover: periodic single probe; success restores.
- `pin: <float>` (score floor) and `ban: true` per chain entry in `lanes.yaml` — human judgment always wins.
- Extend `spread_top` selection to use composite score instead of raw success rate.

**Acceptance:**
- [ ] Seeded model returning truncated streams leaves the spread within 10 requests, no YAML edit
- [ ] Same model auto-recovers after probes succeed
- [ ] The v1 FAST/8b regression reproduced as a fixture and caught by the score
- [ ] `ban: true` beats a perfect score; `pin:` beats a terrible one
- [ ] <10 attempts → no demotion (sparse-data test)
- [ ] Green typecheck/lint/test

---

### M9 — Bench That Ranks Your Tasks

Closes the v1 M5 stub.

**Tasks:**
- `test/tasks/*.md` format: prompt + fixture + deterministic assertions (patch applies / tests pass / output matches) + optional rubric.
- Runner: task × lane × N repeats. Records pass/fail, latency, tokens, hops.
- Grading: deterministic checks first. Rubric grading by a HARD-lane model **offline only** — never on the hot path (SPEC_V2 §4 non-goals).
- Output: markdown leaderboard with per-model score, latency, and variance across repeats.
- `--apply`: emit a `lanes.yaml` **diff for human review**. Never write or commit unattended.
- Document the quota cost of a full run; add a `--budget` cap that stops before exhausting a provider's day.

**Acceptance:**
- [ ] 10 tasks × 5 lanes completes within a documented quota budget, or refuses and says what it needs
- [ ] Repeat-run variance measured and printed; leaderboard reproducible within it
- [ ] `--apply` produces a reviewable diff and writes nothing without confirmation
- [ ] Green typecheck/lint/test

---

### M10 — Forecast & Write-Capable Dashboard

**Tasks:**
- Per-provider burn rate (EWMA req/min) → projected exhaustion timestamp. Expose in `/status`.
- `kompass status` gains a forecast column; banner when any provider is under 15% headroom.
- Existing Vercel app (`kompass-iota`) goes read/write against authenticated Worker endpoints: view lanes/quota/traces, reorder chains, pin/ban models, push config. Same bearer token — **no new auth surface, no new trust boundary**.
- README v2 section: new YAML fields, trace privacy model, bench workflow.

**Acceptance:**
- [ ] Forecast within 20% on a replayed traffic day
- [ ] Dashboard chain reorder takes effect on the next request, no redeploy
- [ ] Unauthenticated dashboard request → 401, asserted in test
- [ ] Fresh-clone README dry run scripted in CI (as v1 M4)
- [ ] Green typecheck/lint/test

---

## §5. Verification protocol

Unchanged from v1 §5:

```
pnpm typecheck && pnpm lint && pnpm test
  → green → git commit → git tag m<N> && git push --tags
  → wrangler deploy → pnpm smoke:deployed   ← against workers.dev, NOT localhost
  → only then: next milestone
```

**Rule:** a milestone without a passing DEPLOYED smoke test is not done.

**New for v2:** the M6 smoke must include a >60k-token request, and the M8 smoke must include a deliberately degraded model fixture. Routing correctness is not observable from a small happy-path request.

---

## §6. Guardrails (additions to v1 §6)

11. **Backward compatibility is a test, not an intention.** A v1 `lanes.yaml` + `providers.yaml` must boot and route identically. This test runs in CI from M6 onward.
12. **Nothing expensive on the hot path.** No tokeniser, no LLM call, no re-serialisation of the request body, no unbounded loop over chain entries. The CPU budget is ~10ms and v1 already spends some of it.
13. **Tracing is fire-and-forget.** `ctx.waitUntil` only. A trace failure never degrades a response.
14. **Redaction by default; full capture is opt-in and TTL-bounded.** No raw prompt bodies in storage unless explicitly requested for that session.
15. **Adaptive scoring must be inspectable and reversible.** Every demotion is logged with its reason. Human YAML (`pin`/`ban`) always overrides the score. Never permanently remove a model without a YAML entry.
16. **Never invent a context window or rate limit.** Same rule as v1 §6.6, and it applies to every new `ctx`/`tpm`/`max_out` value. Verify live; unverifiable → conservative + `TODO(verify)` + `DECISIONS.md`.
17. **Task sizing for free-lane execution.** Each task touches ≤3 files, has its test written first, and covers one concern. Split any task that requires reasoning about Durable Object concurrency *and* adapter translation at once — free models handle either alone and fail at both together.

---

## §7. Dogfooding

Build v2 through Kompass v1 (`claude-free`). It's the honest integration test, and every rough edge it hits is a v2 requirement discovered for free.

**Reserve for native `claude`:** the DO concurrency work in M7 (ring buffer eviction under concurrent writes) and the scoring EWMA state transitions in M8. Both are the kind of subtle-state reasoning where a free model produces plausible code that's wrong under load. Everything else — YAML schema, estimator, CLI, bench runner, dashboard — is well within free-lane range.

Log which milestones completed on free lanes in `DECISIONS.md`. That log is the most credible evidence the project has that it works.

---

## §8. When done (or cannot proceed)

Write `docs/MORNING_REPORT_V2.md`:
- Milestones completed + tags + deployed URL
- Test and deployed-smoke status per milestone
- Which `ctx`/`tpm` values were verified live vs. left as `TODO(verify)`
- Before/after: wasted hops per request, oversize rejections
- Any model auto-demoted during the build, and whether that was correct
- Open blockers with exact error messages
- **The three things the human should review first**
- Which milestones were built on free lanes vs. native `claude`
