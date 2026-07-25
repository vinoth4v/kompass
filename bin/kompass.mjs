#!/usr/bin/env node
// Thin launcher so `npx github:vinoth4v/kompass <cmd>`, an npm install and a
// cloned repo all work: re-runs node with the tsx loader against the TypeScript
// CLI.
//
// The loader MUST be passed as an absolute file: URL. `--import tsx` makes node
// resolve the bare specifier against the process CWD, which is the user's own
// directory for an installed package — there is no tsx there, and the CLI died
// with ERR_MODULE_NOT_FOUND before running a single line. Resolving from this
// file instead finds the copy installed alongside the package.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

let loader;
try {
  loader = pathToFileURL(require.resolve('tsx')).href;
} catch {
  console.error(
    'kompass: could not find the "tsx" runtime.\n' +
      'If you installed this from npm it is a packaging bug — please report it.\n' +
      'In a cloned repo, run: pnpm install',
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', loader, `${root}src/cli/index.ts`, ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: process.cwd() },
);
process.exit(result.status ?? 1);
