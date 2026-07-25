# Claude Code Task — Kompass M6: Onboarding, Credential Bootstrap & Web Auth

You are working in the Kompass repo. Read `docs/SPEC.md`, `docs/BUILD_PLAN.md`, `config/providers.yaml`, and `config/lanes.yaml` before writing any code. **All guardrails in BUILD_PLAN §6 apply unchanged** — pnpm only, no Node-only APIs in `src/worker/` or `src/do/`, no model IDs outside `config/`, green typecheck+lint+test before every commit, one line per non-obvious decision in `docs/DECISIONS.md`, `TODO(verify)` for anything you could not confirm live.

M0–M5 are shipped. This is **M6**. Work the stages in order. **Stop and report at each stage boundary** — do not chain stages without a green deployed smoke test (BUILD_PLAN §5).

---

## The problem

Kompass works, but nobody can install it. Two separate walls:

1. **The CLI install demands ~10 provider API keys up front.** The user must visit ten sites, create ten accounts, and paste ten keys before the first request succeeds. Most people quit at key three.
2. **The web chat app asks for a Cloudflare API key and a worker name.** This is both hostile UX and a real security problem: a Cloudflare token with Workers/KV/DO edit scope is account-wide, and it is being pasted into a page hosted on someone else's infrastructure. It must be removed entirely — the chat app never needs it.

## The goal

- **Minimum viable install = two browser clicks, zero pasted keys.** Cloudflare via `wrangler login`, OpenRouter via OAuth PKCE. Everything else becomes optional and just-in-time.
- **Web app login = handle + passphrase.** No API keys, no worker names, no long hex bearer tokens typed into a browser.

## Explicitly out of scope — do not build, and log the decision

**Automated provider account creation** (headless-browser signup bots for NVIDIA / Google AI Studio / Groq / Mistral / SambaNova / Cohere / HF / Cerebras). Prohibited by most providers' terms, blocked by CAPTCHA and email/phone verification, and unmaintainable — ten live signup DOMs with no deterministic test oracle is the worst possible fit for the free models in our own lane table. Add one line to `docs/DECISIONS.md` recording this and move on. If you find yourself reaching for Playwright against a signup page, stop.

---

## Stage 0 — Recon (do this first, do not skip)

The description of the web app above is inferred from the outside. Before designing anything:

1. Locate the Vercel app source (in-repo or separate — find it), and report: what fields the login/setup screen collects today, where those values are stored (localStorage? cookie? Vercel server-side?), and whether any Vercel-hosted route ever receives them.
2. Confirm the current `/v1/messages` auth path in `src/worker/` and exactly where the bearer check lives.
3. Confirm what the DO exposes today (ledger, stickiness, health, verdict cache) and where a login-attempt counter would slot in.
4. `wrangler --version`, and whether `wrangler login` is already authenticated in this environment.

**Write findings to `docs/DECISIONS.md` and report back before starting Stage 1.** If the actual architecture contradicts anything below, say so and propose the adjustment rather than forcing the design.

---

## Stage 1 — Provider registry schema

Everything downstream reads these fields. Do this first.

Add to each provider block in `config/providers.yaml` (the URLs already exist as comments — promote them to real fields):

```yaml
openrouter:
  # ...existing...
  signup_url: https://openrouter.ai/keys
  auth_method: oauth_pkce        # oauth_pkce | paste | wrangler | gh_cli
  key_pattern: '^sk-or-v1-[A-Za-z0-9]{32,}$'
  probe_model: poolside/laguna-xs-2.1:free
  tier_note: >
    Free tier is 50 RPD. A one-time $10 credit purchase (never expires) raises
    :free models to 1000 RPD. RPM is 20 either way.
```

Rules:
- `probe_model` must be a model already present in `lanes.yaml` for that provider — no new model IDs.
- `key_pattern` is a *format* check only. It is never a substitute for the live probe.
- Provider ordering in the file defines wizard order. Put `openrouter` first.
- Add a top-level `required: [cloudflare, openrouter]` list. Everything else is optional.

**AC**
- [ ] Schema validated at config-compile time; a provider missing `signup_url` or `probe_model` fails the build with a readable error
- [ ] Existing `config push` path still passes tests unchanged

---

## Stage 2 — `kompass keys add <provider>` (the paste path)

One provider, end to end. `init` will reuse this — build it standalone first.

Flow:
1. Print the provider's `tier_note` and open `signup_url` in the default browser (`open` / `xdg-open` / `start`; on failure print the URL).
2. **Clipboard watch** — poll the clipboard (`pbpaste` / `xclip -o` / PowerShell `Get-Clipboard`) every 500ms for a string matching `key_pattern`. On match, auto-fill and show a masked confirmation (`sk-or-v1-…a3f9`). Ctrl-C or `p` falls back to a masked manual prompt. Time out to manual prompt after 120s.
3. Validate against `key_pattern`. On mismatch, show what was expected and re-prompt.
4. **Live probe** — a 1-token completion against `probe_model`. Surface the provider's actual error text on failure (a 401 from a wrong-scoped key must say so *now*, not at 2am mid-session).
5. On success, capture any rate-limit headers the provider exposes (we already do this for Groq's `x-ratelimit-limit-requests`) and append a line to `docs/DECISIONS.md` with observed limits.
6. Write to `secrets/.secrets.json`, chmod `0600`, then `wrangler secret bulk` if already deployed.

Constraints:
- Key material must never reach stdout, logs, or shell history unmasked.
- Idempotent: re-running on a configured provider offers replace / keep / probe-only.
- `--no-clipboard` flag for users who don't want polling.

**AC**
- [ ] A deliberately wrong key is rejected at `keys add` time with the provider's own error message
- [ ] `keys add nvidia` on a fresh machine completes in under 90 seconds including signup
- [ ] Unit test: clipboard watcher matches the right pattern and ignores unrelated clipboard content
- [ ] No key material appears in any log output (grep-asserted in test)

---

## Stage 3 — OpenRouter OAuth PKCE

This is the highest-value single piece — OpenRouter carries the AGENTIC and SIMPLE leads and 1000 RPD.

Flow (verify current endpoints at `openrouter.ai/docs` before coding — log what you confirm):
1. Generate a code verifier; `code_challenge` = base64url(SHA-256(verifier)), `code_challenge_method=S256`.
2. Start a localhost callback server; retry across a small port range if bound.
3. Open `https://openrouter.ai/auth?callback_url=http://localhost:<port>/callback&code_challenge=<challenge>&code_challenge_method=S256`.
4. Receive `code`, exchange at `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method }`.
5. Store the returned key exactly as `keys add` would (probe it too — do not trust the exchange alone).

**Headless fallback is mandatory.** Over SSH, in a container, or in Codespaces there is no browser. Detect this (`$SSH_TTY`, `$DISPLAY`, `--headless`), print the auth URL, and accept the full redirect URL pasted back; parse `code` from it. Time out at 5 minutes with a clear message.

**Verify and report:** does a PKCE-issued key inherit the account's 1000 RPD tier, or start at 50 RPD? If it can land at 50, `init` must tell the user about the one-time $10 unlock at the moment it matters, not bury it in docs.

**AC**
- [ ] `kompass keys add openrouter` completes with zero pasted key material on a machine with a browser
- [ ] Same command works over SSH via the paste-the-redirect-URL path
- [ ] Verifier/challenge pair unit-tested against a known S256 vector
- [ ] Callback server binds only to `127.0.0.1` and shuts down after one request or timeout

---

## Stage 4 — Cloudflare path

Remove the manual API-token step from local installs (BUILD_PLAN §2.1 becomes CI-only).

1. Detect auth state; run `wrangler login` if absent (browser OAuth, one click).
2. `wrangler kv namespace create` for the config namespace; patch the returned ID into `wrangler.toml` automatically — do not make the user copy it.
3. Confirm the DO migration is declared and materialises on first deploy.
4. Detect whether the `workers.dev` subdomain is enabled; if the first deploy needs a one-time enable, say so in plain language with the exact URL.
5. Derive and store the deployed worker URL for the CLI and the web app.

Keep the `CLOUDFLARE_API_TOKEN` path working for CI and non-interactive installs — `wrangler login` is the default, not the only option. Update `docs/BUILD_PLAN.md` §2 to reflect the new prerequisite list.

**AC**
- [ ] Fresh machine with no `CLOUDFLARE_API_TOKEN` reaches a deployed worker with one browser click and no manual token creation
- [ ] `wrangler.toml` KV ID is written automatically; re-running is idempotent and does not create a duplicate namespace
- [ ] CI path (token env var, no browser) still works — asserted in the existing CI job

---

## Stage 5 — `kompass init` orchestrator

Ties Stages 2–4 together.

```
kompass init            # cloudflare → openrouter → passphrase → deploy → smoke → offer extras
kompass init --minimal  # stops after the required set + deploy + smoke
```

- Resumable: state file records completed steps; interrupting at step 4 and re-running resumes at 4.
- Every optional provider is skippable with `s`, with a one-line note on what capacity it adds.
- Ends by running the existing deployed smoke test and printing the result.
- Final output: the deployed URL, the `claude-free()` snippet ready to paste, and the web app URL.

**AC**
- [ ] `kompass init --minimal` on a clean checkout produces a working deployed endpoint with zero pasted API keys
- [ ] Interrupt at any step, re-run, resumes correctly (tested for at least 3 interruption points)
- [ ] Scripted in CI up to the deploy boundary (fresh-clone dry run, per M4 precedent)

---

## Stage 6 — Worker auth: handle + passphrase

This replaces the Cloudflare-key-in-the-browser pattern. **Read this whole stage before designing.**

**Design:**
- **"Username" is the workers.dev handle.** `vinoth` → `https://kompass.vinoth.workers.dev`. Provide an "advanced: custom URL" escape hatch for custom domains. This keeps us stateless — no central directory service, which would break SPEC §3 ("no multi-tenant SaaS", "keys never shared with a third-party operator").
- **Passphrase** is set during `init` and changeable via `kompass passwd`. Offer a generated 4-word diceware default; enforce a minimum entropy floor if the user supplies their own.
- Worker stores `KOMPASS_PASS_HASH`, `KOMPASS_PASS_SALT`, `KOMPASS_PASS_ITER` as secrets. Hashing via WebCrypto `subtle` PBKDF2-SHA256 — no Node APIs, no new deps.
- `POST /auth/login` → on success returns a short-lived session token: HMAC-SHA256 signed (new `KOMPASS_SESSION_SECRET`), 12h TTL, carries issued-at + nonce.
- Session token is accepted **alongside** the existing bearer token. Claude Code and the CLI keep using the bearer path unchanged — two credentials, one gate. Do not weaken or replace the bearer check (BUILD_PLAN §6.10).

**Two things that will bite you — handle them explicitly:**

1. **CPU budget.** SPEC §8 already flags the ~10ms CPU/request free-tier limit as BLOCKING. A naive 600k-iteration PBKDF2 will blow it. Measure actual CPU cost across iteration counts on the deployed worker, pick the highest count that fits with margin, store it in `KOMPASS_PASS_ITER` so it can be raised later without breaking existing hashes, and compensate for the lower count by enforcing passphrase entropy. Write the measured numbers into `docs/DECISIONS.md` and update the SPEC §8 open question with what you found.
2. **Brute force.** Add a login-attempt counter to the DO: 5 attempts per 15 minutes keyed on IP, exponential lockout after that. Failed attempts logged. Use a constant-time digest comparison, and return an identical response shape and timing for "unknown handle" and "wrong passphrase".

**CORS:** the worker must accept the web app origin and `localhost`. Credentials travel in the `Authorization` header, **not cookies** — this avoids CSRF entirely. Do not add cookie auth.

**AC**
- [ ] `POST /auth/login` with correct passphrase returns a session token; the token authenticates `/v1/messages` and `/status`
- [ ] Existing bearer-token path unchanged — full M0–M5 test suite still green, unmodified
- [ ] 6th failed login within 15 min is locked out; unit-tested against the DO
- [ ] Measured PBKDF2 CPU cost recorded in DECISIONS.md and fits the free-tier budget with margin
- [ ] Requests with no credential still get 401 on every non-health route

---

## Stage 7 — Web chat app

**Delete the Cloudflare API key field. Do not replace it, do not hide it behind "advanced." The chat app has no legitimate use for it.** Same for the worker name field as a raw input — it becomes the handle.

New login screen: **two fields, handle and passphrase.** Nothing else.

**Non-negotiable constraint:** the passphrase must go directly from the browser to the user's own Worker via `fetch`. **No Vercel-hosted route may ever receive it.** Vercel serves static assets only. If the current app has any API route in the credential path, remove it. Assert this in the code with a comment and verify it in Stage 0 recon.

- Session token in `sessionStorage`, not `localStorage` — it should not survive a closed tab. Never persist the passphrase in any form.
- On 401, clear the session and return to login with a clear message; do not silently retry.
- Show connection state: which worker URL is active, session expiry, and a visible sign-out.
- Add `kompass ui` to serve the same static bundle locally, for users who would rather not trust a hosted page at all. Mention it on the login screen.

**AC**
- [ ] Login with handle + passphrase reaches a working chat session against the user's own worker
- [ ] Network tab shows zero requests carrying credentials to any non-workers.dev origin
- [ ] No Cloudflare API key field exists anywhere in the app; grep-asserted in test
- [ ] Session survives a page refresh but not a closed tab

---

## Stage 8 — Just-in-time provider acquisition

The reason the ten-key wall can be torn down: the DO quota ledger already knows when capacity is short. Wire it to onboarding.

In `kompass status` and on the read-only status page, when any configured provider crosses 80% of daily quota **and** an unconfigured provider exists:

```
⚠ openrouter  847/1000 RPD (84%)
  Add NVIDIA (~90s, no card) for +5000 RPD across 6 models:
    kompass keys add nvidia
```

Ranked by capacity added, drawn from `providers.yaml` — no hardcoded copy. Users add provider #2 when they can feel the need for it, not while trying to get a first response.

Also add `kompass keys doctor` — re-probe every configured key, report dead / degraded / rate-limited, suggest fixes.

**AC**
- [ ] Nudge fires at the threshold and names the highest-capacity unconfigured provider
- [ ] Nudge never fires when all providers are configured
- [ ] `keys doctor` correctly reports a revoked key as dead

---

## Stage 9 — Docs and landing page

Rewrite for the new reality. The current README quick-start is now wrong.

- **`README.md`:** lead with the two-click install. `kompass init --minimal` → working endpoint. Provider table becomes "optional, add when you need capacity." Keep the trust-model note about request bodies transiting Cloudflare infra (SPEC §8) — do not quietly drop it, and add a matching note that the web app talks browser→your-worker directly.
- **`docs/BUILD_PLAN.md` §2:** manual Cloudflare API token demoted to CI-only. Provider keys become optional.
- **`docs/SPEC.md`:** update §8's CPU-budget open question with the PBKDF2 measurements from Stage 6; add the web-app auth model to §4.
- **Landing page:** the headline is the install, not the architecture diagram. One command, two clicks, what it costs ($0), and the honest constraint (free models, not Opus). Keep it to one screen before the fold.
- **`docs/MORNING_REPORT.md`:** regenerate per BUILD_PLAN §7.

**AC**
- [ ] A reader who has never seen Kompass can get to a working endpoint from the README alone
- [ ] Fresh-clone README dry run scripted in CI (extends the existing M4 job)
- [ ] No doc still instructs anyone to paste a Cloudflare API key into a web page

---

## Reporting

At each stage boundary report: what shipped, what tests cover it, what you could not verify live (with the `TODO(verify)` you left), and anything in this prompt that turned out to be wrong about the actual repo. **Push back rather than working around a bad instruction** — if a stage's design conflicts with what you found in Stage 0, say so and propose the fix before building it.
