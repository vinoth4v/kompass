# Kompass — Product Spec v2 ("Route Well")

**Date:** 24 July 2026 · **Author:** Vinoth Kannan
**Supersedes:** nothing — extends `docs/SPEC.md` (v0.2). All v1 constraints still hold.
**Deployment:** unchanged — single-user Cloudflare Worker, free tier, MIT.

---

## 1. Where v1 landed

v1 shipped past its own M5. As of `lanes.yaml` / `providers.yaml` (2026-07-24):

- **11 providers** wired (openrouter, nvidia, google, groq, mistral, github, cfai, sambanova, cohere, hf; cerebras disabled pending billing activation).
- **5 chat lanes** + `images` + `embeddings` chains, all YAML-driven.
- **`spread_top` weighted-random selection** across the top-N of a chain, weighted by recent live success rate — not just static `chain[0]`.
- **Per-model `multimodal_models`** so a Google outage no longer exhausts every lane for image/PDF traffic.
- **Privacy guard** (regex + glob) gating `trains_on_data: true` providers.
- **Durable Object ledger** with RPM/RPD counters, health cooldowns, session stickiness.

v1 answered the question *"can free models be routed at all?"* — yes, and with far more depth than the original lane table.

---

## 2. The v2 problem

**v1 optimises for availability. It has almost no signal about whether the answer was any good, and no model of whether a request will even fit.**

Three failure classes survive into v1, all visible in the repo's own notes:

1. **Fit failures.** No model in the registry declares its context window or TPM ceiling. `github/openai/gpt-4.1` was removed from LONGCTX only *after* discovering its hard 8k cap the expensive way. Groq's 6–12k TPM means oversized requests "get rejected upstream and fall through the chain" — every one of those rejections is a wasted hop, added latency, and a consumed daily request.

2. **Silent quality failures.** `spread_top` weights by *live success rate* — HTTP 200 and a completed stream. A model returning fluent nonsense scores identically to one that solves the task. The `lanes.yaml` FAST comment is a documented instance: *"promoting groq's 8b model there earlier caused vague/hedging answers even though it was healthy."* That was caught by a human noticing, and fixed by hand-editing YAML. That does not scale.

3. **Blind spend.** `kompass status` reports quota *now*. There is no burn-rate projection, so you discover a provider is exhausted at the moment it blocks you — typically mid-task.

**Cost of not solving:** the routing gets better only as fast as the operator manually notices problems and edits YAML. Every model added (and the third-pass probe notes show a lot were) widens the surface a human has to babysit.

---

## 3. Goals (v2)

| # | Goal | Measured by |
|---|---|---|
| G1 | **A model is never sent a request it structurally cannot accept.** | Zero context-overflow / oversize rejections in a 200-request replay |
| G2 | **A degraded model demotes itself without a YAML edit.** | Seeded degraded model out of the spread window within K=10 requests, auto-recovers on probe |
| G3 | **Every request can explain itself.** | Any route reconstructable from `kompass trace <id>`: verdict, confidence, chain considered, every hop and why |
| G4 | **Chain order is evidence-based.** | `kompass bench` ranks models on *your* task suite and emits a reviewable `lanes.yaml` diff |
| G5 | **You see exhaustion coming.** | Burn-rate forecast within 20% of actual on a replayed traffic day |

**Inherited and non-negotiable:** $0 models, $0 infra, Cloudflare free-tier CPU budget, YAML-first (no code to add a model), no paid model without `allow_paid: true`.

---

## 4. Non-goals (v2) — and why

These are the things I'd push back on. Each is a real request that sounds reasonable and is wrong for this codebase.

| Non-goal | Why not |
|---|---|
| **Exact tokenisation in the Worker** | A BPE tokeniser over a 400KB body is 50–200ms of CPU. The free tier gives ~10ms per request. Use byte-length ÷ calibrated ratio, corrected from each provider's returned `usage.prompt_tokens`. Accuracy of ±10% is enough to make a fit decision; exactness costs the whole CPU budget. |
| **Kompass-side context compaction / summarisation** | Claude Code already compacts its own history. A second, invisible compaction layer risks dropping the exact line the agent needed, is undebuggable from the client, and adds a model call to the hot path. Solve fit by *routing*, not by *rewriting the user's request*. |
| **Trained RouteLLM-style classifier** | Needs labelled data, a training pipeline, and somewhere to run inference. Not free, not 10ms. The tractable version is distilling logged verdicts into an expanded deterministic heuristic table — inspectable, free, and it shrinks classifier calls rather than replacing them. Keep as P2. |
| **Ollama / local lane** | A Cloudflare Worker cannot reach your localhost. This needs a tunnel or client-side egress — a different topology, not a new lane. If you want it, it's a CLI-side shim, and it's its own project. |
| **Cross-provider context resumption** | Handing a half-finished stream from Gemini to MiniMax with a summarised state is lossy, non-deterministic, and would need every adapter to agree on a state format. The existing escalation path (lane up, then "switch to native `claude`") is the honest answer. |
| **Inline LLM-as-judge on quality** | Doubles latency and cost on every request, and free judge models are not reliable enough to demote a model on. Judging belongs in the offline bench (M9), never on the hot path. |
| **Multi-tenant / shared endpoint** | Provider keys are shared, so tenants share a trust domain and you carry liability for their traffic. Free-tier quotas do not survive multiple heavy users. See §9 for the narrow version that *would* be tractable. |
| **RAG over the repo** | Kompass is a router. Claude Code owns file selection. The `embeddings` chain exists to serve clients, not for Kompass to do retrieval on their behalf. |
| **Automatic paid fallback when free lanes exhaust** | Directly violates the $0 promise and guardrail §6.8. The synthetic "switch to native `claude`" notice stays the terminal state. |

---

## 5. Architecture deltas

Three new stages. Everything else is v1 unchanged.

```
INGRESS ──▶ PRE-FILTER ──▶ DISPATCHER ──▶ LANE TABLE
   │                                          │
   │ capture raw byte length once             ▼
   │ (no re-serialisation)              PRIVACY GUARD
                                              ▼
                                     ╔════════════════╗
                                     ║  FIT FILTER    ║  ◀── NEW (M6)
                                     ║  drop entries  ║
                                     ║  that can't    ║
                                     ║  hold this req ║
                                     ╚════════════════╝
                                              ▼
                                        QUOTA LEDGER
                                              ▼
                                     ╔════════════════╗
                                     ║  SCORER        ║  ◀── NEW (M8)
                                     ║  health ×      ║
                                     ║  quality       ║
                                     ║  → spread wgt  ║
                                     ╚════════════════╝
                                              ▼
                                          ADAPTERS
                                              ▼
                                     ╔════════════════╗
                                     ║  TRACE SINK    ║  ◀── NEW (M7)
                                     ║  ctx.waitUntil ║
                                     ║  DO ring buf   ║
                                     ╚════════════════╝
```

**Ordering matters:** the fit filter runs *after* the privacy guard. Otherwise a request could be routed to a bigger `trains_on_data: true` model in preference to a smaller safe one — fit must never override privacy.

### New YAML surface (all optional, all defaulted)

```yaml
# providers.yaml
nvidia:
  default_ctx: 128000        # fallback when a model declares nothing
  model_limits:
    minimaxai/minimax-m3: { rpm: 40, rpd: 5000, ctx: 1000000, max_out: 32000 }
groq:
  limits: { rpm: 30, rpd: 1000, tpm: 12000 }   # TPM is the real Groq constraint

# lanes.yaml
lanes:
  FAST:
    spread_top: 1
    chain:
      - google/gemini-3.5-flash-lite
      - { model: groq/llama-3.1-8b-instant, ban: true }   # human judgment wins
      - { model: mistral/mistral-small-latest, pin: 0.9 } # floor the score
```

A config with none of these fields must boot and route **identically to v1**. Missing `ctx` = unknown, which ranks a model last in the fit ordering but never hard-drops it.

### Estimator

```
est_in  = raw_body_bytes / ratio[provider]      # ratio seeded at 3.6 (code is token-dense)
need    = est_in + max_out_requested + 10% headroom
keep m  if  need <= m.ctx  AND  est_in <= m.tpm (when declared)
```

`ratio[provider]` is an EWMA corrected from each response's `usage.prompt_tokens`. Self-calibrating, O(1) state, no tokeniser.

### Quality score

```
health(m)  = EWMA over {completed stream = 1, 5xx/429/timeout/truncated = 0}, α=0.2
quality(m) = clamp(1 − penalties/attempts, floor 0.1)
   penalties: escalation attributed to m       +1.0
              malformed tool call               +0.7
              empty or truncated completion     +0.7
              corrective user turn within 2     +0.4   (declared regex list, tunable)
score(m)   = health × quality      spread weight = score²
```

Scored **per (model, lane)** — a model can be excellent in SIMPLE and poor in AGENTIC.

---

## 6. User stories

Each tagged with the milestone that delivers it (see `BUILD_PLAN_V2.md`).

### Persona A — Pro-Subscriber Developer (primary)

- **[M6]** As a developer pasting a 90k-token file dump, I want Kompass to only try models that can actually accept it, so that I'm not waiting through three doomed hops before I get an answer.
- **[M6]** As a developer whose request fits nothing, I want a synthetic message naming the largest window available, so that I know whether to trim the request or switch to native `claude` — instead of watching a chain fail silently.
- **[M8]** As a developer mid-session, I want a model that has started returning junk to stop receiving my traffic automatically, so that I don't have to notice the degradation myself and hand-edit YAML.
- **[M10]** As a developer about to start a long refactor, I want to see "OpenRouter exhausts in ~3h at this rate", so that I can decide whether to start now or shift to a provider with headroom.

### Persona B — Zero-Budget Developer

- **[M6]** As a zero-budget developer, I want oversized requests skipped rather than sent-and-rejected, so that failed attempts stop burning my daily request quota. *(A 400 from a provider still counts against RPD — this is the highest-leverage story in v2.)*
- **[M8]** As a zero-budget developer, I want my limited daily requests weighted toward models that actually finish tasks, so that scarce quota buys completed work rather than plausible-looking retries.
- **[M10]** As a zero-budget developer, I want a per-provider burn-rate forecast, so that I can move heavy work before I'm blocked rather than after.

### Persona C — Tinkerer / Model Evaluator

- **[M7]** As a tinkerer, I want a per-request trace showing the verdict, confidence, every attempt and the reason for each hop, so that I can diagnose a misroute in one command instead of inferring it from logs.
- **[M7]** As a tinkerer, I want `kompass replay <trace> --model X`, so that I can A/B a routing change against real traffic without waiting for the situation to recur.
- **[M9]** As a tinkerer, I want `kompass bench` to score a newly-released model on my own 10 tasks and tell me where it belongs in the chain, so that promoting a model is evidence rather than vibes. *(The repo's probe notes are already doing this by hand.)*
- **[M9]** As a tinkerer, I want `bench --apply` to emit a `lanes.yaml` diff I review before committing, so that automation proposes and I dispose.
- **[M8]** As a tinkerer, I want `pin:` and `ban:` in YAML to override the adaptive score, so that my judgment always beats the heuristic — as it did for the FAST/8b case.

### Persona D — Privacy-Conscious Enterprise Developer

- **[M7]** As an enterprise developer, I want traces to store metadata and redacted digests by default and never raw prompt bodies, so that debugging doesn't quietly create a second copy of my source code.
- **[M7]** As an enterprise developer, I want full-body capture to be explicit, per-session, and TTL-bounded, so that I choose when detail is worth the exposure.
- **[M6]** As an enterprise developer, I want the fit filter to run after the privacy guard, so that a bigger `trains_on_data: true` model is never preferred over a smaller safe one.

### Edge cases

- Request fits *nothing* in any lane → synthetic notice with the largest available window, not a silent 5-hop failure.
- All `ctx` fields absent (a v1 config) → fit filter is inert, routing is byte-identical to v1.
- Quality data too sparse (<10 attempts on a model) → score defaults to health only; no demotion on thin evidence.
- Trace store at capacity → oldest evicted; tracing never blocks or fails a response.

---

## 7. Requirements

### P0 — v2 cannot ship without

1. **Per-model context/TPM declaration + fit filter.**
   *AC: given a 200k-char request, no model with `ctx < need` is dispatched to; trace shows each skip with the numbers.*
2. **Self-calibrating token estimator.**
   *AC: after 50 real requests, per-provider ratio is within 15% of observed `usage.prompt_tokens`.*
3. **Backward-compatible config.**
   *AC: v1's `lanes.yaml` + `providers.yaml`, unmodified, boot and produce the same routing decisions.*
4. **Trace store with redaction by default.**
   *AC: a trace of a request containing a seeded secret contains no raw prompt text; 500-request soak stays within DO storage and adds 0ms to p50.*
5. **Quality-weighted spread with auto-demote and auto-recover.**
   *AC: a seeded model returning truncated streams leaves the spread window within 10 requests without a YAML edit, and returns after a successful probe.*
6. **Human override.**
   *AC: `ban:` beats a perfect score; `pin:` beats a terrible one.*

### P1 — should have

- `kompass bench` with deterministic grading + offline rubric grading, markdown leaderboard, `--apply` diff.
- Burn-rate forecast in `/status` and `kompass status`.
- Write-capable dashboard (reorder chain, pin/ban, push config) on the existing Vercel app, behind the same bearer.
- `kompass replay`.

### P2 — future (design for, don't build)

- Distilled heuristic table from logged verdicts, shrinking classifier calls.
- Self-hosted SQLite `StateStore` adapter (interface already exists).
- Narrow multi-user (see §9).

---

## 8. Success metrics

| Metric | Target | Type |
|---|---|---|
| Oversize/context-overflow rejections | → 0 (from current unmeasured baseline) | Leading |
| Wasted hops per request (attempts before success) | ↓ 30% | Leading |
| Fit filter CPU cost | <1ms added | Leading |
| Time from model degradation → demotion | <10 requests, no human action | Leading |
| Misroutes diagnosable from a single trace | 100% | Leading |
| Forecast accuracy (4h horizon) | within 20% | Leading |
| Manual `lanes.yaml` edits per month | ↓ 50% vs. v1 | Lagging |
| First-attempt lane acceptance (v1 metric) | ≥85% held, ideally ↑ | Lagging |

---

## 9. Open questions

- **[BLOCKING — engineering]** Trace storage: KV free tier is ~1,000 writes/day, which a heavy Claude Code day (2–5k requests) blows through. Assumption in this spec is a **DO-storage ring buffer** instead. Confirm DO storage limits and per-write cost against a 500-entry buffer before M7.
- **[BLOCKING — engineering]** Does the fit filter plus estimator fit the ~10ms free-tier CPU budget on a 400KB body? Measure before building on top of it. This is the same CPU question v1 §8 flagged and never closed.
- **[engineering]** Corrective-turn detection: can "the user just told the model it was wrong" be detected reliably enough from the Anthropic message stream to carry a quality penalty, or is it too noisy? Ship it behind a config flag, off by default, until there's data.
- **[engineering]** Should quality score be per-`(model, lane)` or per-`(model, lane, task-shape)`? Per-lane is the assumption; finer granularity may be too sparse to ever cross the confidence threshold.
- **[product]** Bench cost: 10 tasks × 5 lanes × N repeats may exceed a day's free quota on its own. Does bench get its own quota carve-out, or run overnight against a reserved budget?
- **[product]** Narrow multi-user — the tractable version is: multiple bearer tokens → tenant IDs → namespaced ledger + a fair-share cap, **explicitly not** key isolation (keys stay shared, trust domain stays single). Worth a milestone, or does it break the "personal Worker" positioning that makes the trust model simple?
- **[legal]** Trace retention with full-body opt-in: does storing request bodies in a Durable Object change the privacy story the README makes? Document before shipping the opt-in.

---

## 10. Timeline & phasing

Five milestones, **M6 → M10**, continuing v1's tag sequence (`m0`–`m5` already used). Strict order — M8 consumes M7's data, M9 validates M6 and M8.

M6 is the one that pays for itself immediately: it stops burning quota on requests that were never going to succeed. If v2 gets cut short, ship M6 and stop.
