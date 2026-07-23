# Kompass — Decision Log

One line per non-obvious decision, newest at bottom (BUILD_PLAN §6.3).

- 2026-07-23: Moved root `KOMPASS_SPEC.md` → `docs/SPEC.md` to match the layout in BUILD_PLAN §3.
- 2026-07-23: `GROQ_API_KEY` absent from `secrets/.secrets.json` → Groq ships as a disabled provider (registry `enabled: false` in M1); degrade gracefully per BUILD_PLAN §2.
- 2026-07-23: Verified live (`GET openrouter.ai/api/v1/models`): `poolside/laguna-s-2.1:free` alive (1 active endpoint) → M0 primary. Planned fallback `qwen/qwen3-coder:free` is dead-listed → substituted `poolside/laguna-xs-2.1:free` (alive, tools, 262k ctx).
- 2026-07-23: pnpm 11 ignores `pnpm.onlyBuiltDependencies` in package.json → build approvals live in `pnpm-workspace.yaml` (`allowBuilds`: esbuild/workerd true, sharp false).
- 2026-07-23: Bearer auth accepts both `Authorization: Bearer` and `x-api-key` headers (Claude Code sends either depending on ANTHROPIC_AUTH_TOKEN vs ANTHROPIC_API_KEY); constant-time compare.
- 2026-07-23: Implemented `/v1/messages/count_tokens` as a chars/4 estimate so Claude Code context tracking doesn't 404.
- 2026-07-23: Local workerd (vitest pool) caps compatibility_date at 2025-10-11 and warns on our 2026-07-01; harmless — production accepts the newer date.
