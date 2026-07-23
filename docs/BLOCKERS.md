# Kompass — Blockers

## ~~Git push blocked: placeholder remote~~ — RESOLVED 2026-07-23

Resolved same day: installed `gh` via Homebrew, user completed `gh auth login --web`,
created private repo `vinoth4v/kompass`, switched origin to HTTPS, pushed all commits
+ tags m0–m5. CI (readme-dryrun) triggered on first push. Original entry kept below
for the record.

## Git push blocked: placeholder remote (open, non-fatal)

- **When:** 2026-07-23, M0 push step (BUILD_PLAN §5).
- **What:** `git push -u origin main --tags` fails: `Host key verification failed. / Could not read from remote repository.`
- **Cause:** `origin` is the template placeholder `git@github.com:YOURUSER/kompass.git`; no `gh` CLI installed to create/fix a repo non-interactively, and SSH host verification for github.com is not set up in this shell.
- **Attempted:** direct push (failed); `gh auth status` (gh not installed).
- **Impact:** commits and milestone tags (`m0`…) exist locally only. Everything else (deploy, smoke, later milestones) proceeds — per §6.4 this blocked step is skipped, all non-dependent work continues. Each milestone still commits + tags locally; a single `git push -u origin main --tags` once the remote is fixed brings the remote fully up to date.
- **Human fix:** `git remote set-url origin git@github.com:<real-user>/kompass.git` (create the repo first), ensure SSH key + known_hosts (`ssh -T git@github.com`), then `git push -u origin main --tags`.

## GROQ_API_KEY missing (noted, by design)

- `secrets/.secrets.json` has no `GROQ_API_KEY`. Groq is registered as a disabled provider; lanes route around it. Add the key + `kompass config push` to enable later.
