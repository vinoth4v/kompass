#!/usr/bin/env node
// Thin launcher so `npx github:vinoth4v/kompass <cmd>` and a future npm package
// both work: re-runs node with the tsx loader against the TypeScript CLI.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', `${root}src/cli/index.ts`, ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: process.cwd() },
);
process.exit(result.status ?? 1);
