#!/usr/bin/env node
// Compiles config/*.yaml into a TypeScript module bundled with the Worker.
//
// Why this exists: a gateway deployed with the Deploy-to-Cloudflare button has
// an EMPTY KV namespace, so loadConfig() returned null and every request 503'd
// with "no config in KV — run `kompass config push`" — a CLI command a
// browser-only user cannot run. The deploy was therefore useless on arrival.
// Bundling the config means a fresh Worker routes correctly the moment it
// exists, and `config push` becomes an override rather than a prerequisite.
//
// Regenerate with `pnpm config:build`; `pnpm lint` fails if it is stale.
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// `version` is a compile timestamp, so leaving it in would make this file
// differ on every run and the staleness check would never pass. The bundled
// copy is marked instead, which also makes it obvious in /config which one is
// serving.
const json = execSync(
  "npx tsx -e \"import{compileConfig}from'./src/cli/compile-config.ts';" +
    "const c=compileConfig('config');c.version='bundled';console.log(JSON.stringify(c,null,2))\"",
  { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);

const out = `// GENERATED FILE — do not edit. Run \`pnpm config:build\` after changing
// config/lanes.yaml or config/providers.yaml. \`pnpm lint\` fails if it is stale.
//
// This is the lane table a freshly deployed Worker uses when its KV namespace is
// empty, which is the normal state after a Deploy-to-Cloudflare install. Without
// it the gateway answers 503 until someone runs the CLI — see
// scripts/build-default-config.mjs.
import type { RouterConfig } from './config';

export const DEFAULT_CONFIG: RouterConfig = ${json.trim()} as unknown as RouterConfig;
`;
writeFileSync('src/worker/default-config.ts', out);
console.log('✓ src/worker/default-config.ts regenerated from config/');
