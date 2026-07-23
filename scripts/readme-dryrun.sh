#!/usr/bin/env bash
# M4 acceptance: fresh-clone dry run of the README steps, minus the real deploy.
# Run in CI and locally. Exercises: install → secrets file shape → config compile →
# typecheck/lint/test → wrangler dry-run build.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== install =="
pnpm install --frozen-lockfile

echo "== secrets file (dry-run shape, fake keys) =="
mkdir -p secrets
if [ ! -f secrets/.secrets.json ]; then
  cat > secrets/.secrets.json <<EOF
{
  "KOMPASS_BEARER": "$(openssl rand -hex 24)",
  "OPENROUTER_API_KEY": "sk-or-v1-dryrun",
  "NVIDIA_API_KEY": "nvapi-dryrun",
  "GOOGLE_AI_KEY": "AIza-dryrun"
}
EOF
  echo "  wrote placeholder secrets/.secrets.json"
else
  echo "  secrets/.secrets.json already present, leaving untouched"
fi

echo "== config compiles and validates =="
pnpm exec tsx -e "import {compileConfig} from './src/cli/compile-config'; const c = compileConfig(); console.log('  lanes:', Object.keys(c.lanes).join(', '))"

echo "== typecheck + lint + tests =="
pnpm typecheck
pnpm lint
pnpm test

echo "== wrangler build (dry run, no deploy) =="
pnpm exec wrangler deploy --dry-run --outdir /tmp/kompass-dryrun-dist

echo "README dry run OK"
