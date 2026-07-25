#!/usr/bin/env node
// wrangler.test.jsonc exists only because the Workers AI binding cannot run
// under local Miniflare (no local implementation — the pool would try a remote
// proxy session and fail without `wrangler login`).
//
// That is a real drift risk: a binding added to production config would be
// missing from every test, and the suite would stay green while the deployed
// worker used something never exercised. This asserts the two files are
// identical apart from the `ai` key. Run from `pnpm lint` and CI.
import { readFileSync } from 'node:fs';

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
console.log('✓ wrangler config parity (test config = production minus the ai binding)');
