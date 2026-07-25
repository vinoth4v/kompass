#!/usr/bin/env node
// wrangler.test.jsonc exists only because the Workers AI binding cannot run
// under local Miniflare (no local implementation — the pool would try a remote
// proxy session and fail without `wrangler login`).
//
// That is a real drift risk: a binding added to production config would be
// missing from every test, and the suite would stay green while the deployed
// worker used something never exercised. This asserts the two files are
// identical apart from the `ai` key. Run from `pnpm lint` and CI.
import { readFileSync, writeFileSync } from 'node:fs';

/** Minimal JSONC → JSON: strip // and block comments comments and trailing commas. */
function parseJsonc(path) {
  const raw = readFileSync(path, 'utf8');
  const stripped = raw
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ''))
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

const prod = parseJsonc('wrangler.jsonc');
const test = parseJsonc('wrangler.test.jsonc');

const problems = [];
if (!prod.ai) problems.push('wrangler.jsonc is missing the "ai" binding');
if (test.ai) problems.push('wrangler.test.jsonc must NOT declare the "ai" binding');

delete prod.ai;
const a = JSON.stringify(prod, Object.keys(prod).sort());
const b = JSON.stringify(test, Object.keys(test).sort());
if (a !== b) {
  problems.push(
    'wrangler.test.jsonc has drifted from wrangler.jsonc.\n' +
      'They must match except for the "ai" binding — copy the change across.',
  );
}

if (problems.length) {
  console.error('✗ wrangler config parity:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
// The bundled default config must match config/*.yaml, or a fresh deployment
// routes with a lane table nobody has seen. Same drift risk as above.
import { execSync as exec } from 'node:child_process';
const current = readFileSync('src/worker/default-config.ts', 'utf8');
exec('node scripts/build-default-config.mjs', { stdio: 'pipe' });
const rebuilt = readFileSync('src/worker/default-config.ts', 'utf8');
if (current !== rebuilt) {
  writeFileSync('src/worker/default-config.ts', current); // leave the tree as found
  console.error(
    '✗ src/worker/default-config.ts is stale.\n' +
      '  config/*.yaml changed without regenerating it — run: pnpm config:build',
  );
  process.exit(1);
}

console.log('✓ wrangler config parity, and the bundled default config is current');
