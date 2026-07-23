# Kompass — Morning Report (2026-07-23)

All six milestones **M0 → M5 are complete, deployed, and smoke-verified against the
live Worker**. 46 tests green, typecheck+lint green at every commit.

## Deployed Worker

**https://kompass.vinoth4v.workers.dev** (workers.dev subdomain `vinoth4v` was registered
via API during the run — the account had none). Status page:
`https://kompass.vinoth4v.workers.dev/status.html` (enter your KOMPASS_BEARER once).

## Milestones

| Milestone                              | Tag  | Deployed smoke result                                                                                                                       |
| -------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 scaffold + passthrough              | `m0` | 401-gate ✓ · streamed completion ✓ · tool round-trip ✓                                                                                      |
| M1 adapters + KV registry + hot-reload | `m1` | same toy tool-task ✓ on NVIDIA (OpenAI-format) AND Gemini; config push switches chains with no redeploy (test-proven)                       |
| M2 DO ledger + fallback + stickiness   | `m2` | burned OpenRouter to 50/50 → next request skipped it with **zero 429s**, NVIDIA timed out → 10-min cooldown, Gemini served; hops in /status |
| M3 dispatcher classifier               | `m3` | p50 added latency **0ms** (heuristic short-circuits), classifier max ~680ms, verdict cache hits confirmed live                              |
| M4 CLI + status + README               | `m4` | `kompass status` table live; status.html live; `scripts/readme-dryrun.sh` (CI workflow included) passes locally                             |
| M5 privacy + escalation + bench stub   | `m5` | privacy skip + escalation + synthetic HARD-exhausted notice all test-proven; deployed smoke green                                           |

All milestone tags exist **locally only** — see blockers.

## Providers (live state at report time)

| Provider   | State        | Ledger (RPD used/limit) | Notes                                                                                                                                                                                |
| ---------- | ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| openrouter | live         | 10/50                   | free-tier key: 20 RPM / 50 RPD (verified in docs). Poolside Laguna endpoints intermittently upstream-rate-limited and sometimes slow. `trains_on_data: true` (privacy guard applies) |
| nvidia     | live         | 2/5000                  | big models (glm-5.2, deepseek-v4) frequently cold/congested (503 "48/48", >90s) → cooldowns route around them; nemotron-super-49b is fast. kimi-k2.6 404s on this key → removed      |
| google     | live         | 2/500                   | serves the classifier (flash-lite) + FAST/HARD/LONGCTX entries; limits are conservative TODO(verify) — real numbers only visible in the AI Studio dashboard                          |
| groq       | **disabled** | —                       | no `GROQ_API_KEY` in secrets/.secrets.json; slugs unverifiable without a key, so no lane entries either                                                                              |

## Open blockers (docs/BLOCKERS.md)

1. **Git push**: `origin` is the placeholder `git@github.com:YOURUSER/kompass.git` and no
   `gh` CLI is installed. All 9 commits + 6 tags are local. Fix:
   `git remote set-url origin git@github.com:<you>/kompass.git && git push -u origin main --tags`.
2. **GROQ_API_KEY missing** (by design, degraded gracefully).

## Three things to review first

1. **Real Claude Code session from your two machines** — the one acceptance I cannot do
   for you. Paste the `claude-free()` snippet below on both machines and run a real
   agentic session (file edits + bash). The smoke harness proves protocol correctness
   (streaming, tool round-trips, thinking blocks) but not a full 20-turn session.
2. **Google free-tier limits** (`config/providers.yaml`): I set conservative values
   (flash-lite 15 RPM/1000 RPD, pro 2 RPM/50 RPD) because ai.google.dev no longer
   publishes numbers — check https://aistudio.google.com/rate-limit and correct, then
   `pnpm kompass config push`. Same for NVIDIA's 40 RPM (per-key vs per-model unknown).
3. **AGENTIC lane ordering**: Poolside Laguna-S is the best free tool-caller but its
   single OpenRouter endpoint was flaky today (429s upstream, one 137s stream). If your
   first real session feels slow, consider promoting `google/gemini-3.6-flash` in
   `config/lanes.yaml` — hot-reloads without redeploy.

## Paste into ~/.zshrc

```sh
claude-free() {
  ANTHROPIC_BASE_URL="https://kompass.vinoth4v.workers.dev" \
  ANTHROPIC_AUTH_TOKEN="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/Documents/workspace/kompass/secrets/.secrets.json"))["KOMPASS_BEARER"])')" \
  ANTHROPIC_MODEL="claude-sonnet-4-5" \
  claude "$@"
}
```

(Or inline the token on your second machine — it's the `KOMPASS_BEARER` value from
`secrets/.secrets.json`.)

## Numbers

- 9 commits, 6 tags (m0…m5), 46 tests across 6 files, 0 skipped.
- Worker version `044eda19…` live; KV namespace `45e10070…`; DO class `KompassState` (SQLite-backed).
- Today's config version pushed: `2026-07-23T10:41:31Z`.
- Full decision log: `docs/DECISIONS.md` (24 entries — the Gemini `thoughtSignature`
  placeholder and the awaited-DO-write fix are the two most instructive).
