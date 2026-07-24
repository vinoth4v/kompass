// `kompass init` — one-command guided setup: prereqs → keys → Cloudflare KV +
// workers.dev subdomain → deploy → secrets → config push → smoke → shell snippet.
// Idempotent: safe to re-run; existing files/resources are detected and kept.
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const die = (s: string): never => {
  console.error(`  \x1b[31m✗\x1b[0m ${s}`);
  process.exit(1);
};

async function ask(q: string, def = ''): Promise<string> {
  const a = (await rl.question(`  ${q}${def ? ` [${def}]` : ''}: `)).trim();
  return a || def;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  return res.json();
}

export async function init(): Promise<void> {
  console.log(`\n${bold('🧭 Kompass setup')} — free-model gateway for Claude Code\n`);

  const secretsPath = 'secrets/.secrets.json';

  // 1. Prerequisites -----------------------------------------------------------
  console.log(bold('1/6 Prerequisites'));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) die(`Node ${process.versions.node} found — need Node 20+`);
  ok(`Node ${process.versions.node}`);

  // Resolve Cloudflare token: env → secrets file → interactive prompt.
  // This lets `pnpm kompass init` work without any prior `export` step.
  if (!process.env.CLOUDFLARE_API_TOKEN && existsSync(secretsPath)) {
    try {
      const stored = JSON.parse(readFileSync(secretsPath, 'utf8'));
      if (stored.CLOUDFLARE_API_TOKEN) {
        process.env.CLOUDFLARE_API_TOKEN = stored.CLOUDFLARE_API_TOKEN;
        ok('CLOUDFLARE_API_TOKEN loaded from secrets/.secrets.json');
      }
    } catch {
      /* malformed file — handled in step 2 */
    }
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.log('  No Cloudflare API token found. Create one at:');
    console.log('    https://dash.cloudflare.com/profile/api-tokens');
    console.log('  Use template "Edit Cloudflare Workers" and add KV Storage:Edit scope.\n');
    const t = (await ask('Paste your Cloudflare API token')).trim();
    if (!t) die('A Cloudflare API token is required to continue.');
    process.env.CLOUDFLARE_API_TOKEN = t;
  }

  const accounts = await cf('/accounts');
  const account = accounts?.result?.[0];
  if (!account) die('Cloudflare token works but lists no accounts — check token scopes.');
  ok(`Cloudflare account: ${account.name} (${account.id.slice(0, 8)}…)`);

  // 2. Provider keys → secrets/.secrets.json -----------------------------------
  console.log(
    `\n${bold('2/6 Provider API keys')} (stored ONLY in local secrets/.secrets.json, gitignored)`,
  );
  let secrets: Record<string, string>;
  if (existsSync(secretsPath)) {
    secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
    // Back-fill CF token so future re-runs on any machine need no env var.
    if (!secrets.CLOUDFLARE_API_TOKEN) {
      secrets.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
      writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n');
    }
    ok(`existing ${secretsPath} found (${Object.keys(secrets).length} keys) — keeping it`);
  } else {
    console.log('  All four are free tiers, no credit card. Leave any blank to skip it.\n');
    secrets = {
      KOMPASS_BEARER: randomBytes(24).toString('hex'),
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN!,
    };
    const wanted: Array<[string, string, string]> = [
      ['OPENROUTER_API_KEY', 'OpenRouter key (sk-or-v1-…)', 'https://openrouter.ai/keys'],
      [
        'NVIDIA_API_KEY',
        'NVIDIA Build key (nvapi-…)',
        'https://build.nvidia.com  (any model page → "Get API Key")',
      ],
      ['GOOGLE_AI_KEY', 'Google AI Studio key (AIza…)', 'https://aistudio.google.com/apikey'],
      ['GROQ_API_KEY', 'Groq key (gsk_…)', 'https://console.groq.com/keys'],
    ];
    for (const [envKey, label, link] of wanted) {
      console.log(`  create at: ${link}`);
      const v = await ask(label);
      if (v) secrets[envKey] = v;
    }
    if (Object.keys(secrets).length === 2) die('No provider keys entered — need at least one.');
    mkdirSync('secrets', { recursive: true });
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n');
    ok(`wrote ${secretsPath} (bearer token auto-generated)`);
  }

  // 3. KV namespace ------------------------------------------------------------
  console.log(`\n${bold('3/6 Workers KV namespace')}`);
  const kvList = await cf(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`);
  let kv = kvList?.result?.find(
    (n: any) => n.title.includes('CONFIG') && n.title.includes('kompass'),
  );
  if (kv) {
    ok(`existing namespace "${kv.title}" (${kv.id})`);
  } else {
    const created = await cf(`/accounts/${account.id}/storage/kv/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ title: 'kompass-CONFIG' }),
    });
    kv = created?.result ?? die(`KV create failed: ${JSON.stringify(created?.errors)}`);
    ok(`created namespace "kompass-CONFIG" (${kv.id})`);
  }
  const wranglerPath = 'wrangler.jsonc';
  const wrangler = readFileSync(wranglerPath, 'utf8');
  const patched = wrangler.replace(
    /("binding":\s*"CONFIG",\s*\n\s*"id":\s*")[^"]+(")/,
    `$1${kv.id}$2`,
  );
  if (patched !== wrangler) {
    writeFileSync(wranglerPath, patched);
    ok(`wrangler.jsonc patched with your namespace id`);
  } else {
    ok('wrangler.jsonc already points at this namespace');
  }

  // 4. workers.dev subdomain ---------------------------------------------------
  console.log(`\n${bold('4/6 workers.dev subdomain')}`);
  let sub = (await cf(`/accounts/${account.id}/workers/subdomain`))?.result?.subdomain;
  if (sub) {
    ok(`existing subdomain: ${sub}.workers.dev`);
  } else {
    const wanted = await ask('Choose your workers.dev subdomain (letters/numbers/dashes)');
    if (!wanted) die('A workers.dev subdomain is required for the public URL.');
    const reg = await cf(`/accounts/${account.id}/workers/subdomain`, {
      method: 'PUT',
      body: JSON.stringify({ subdomain: wanted }),
    });
    sub =
      reg?.result?.subdomain ??
      die(`subdomain registration failed: ${JSON.stringify(reg?.errors)}`);
    ok(`registered ${sub}.workers.dev (TLS cert can take ~2 min on first use)`);
  }
  const url = `https://kompass.${sub}.workers.dev`;

  // 5. Deploy + secrets + config ----------------------------------------------
  console.log(`\n${bold('5/6 Deploy')}`);
  execSync('pnpm exec wrangler deploy', { stdio: 'inherit' });
  execSync(`pnpm exec wrangler secret bulk ${secretsPath}`, { stdio: 'inherit' });
  const push = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', 'config', 'push', '--url', url],
    { stdio: 'inherit', env: process.env },
  );
  if (push.status !== 0) die('config push failed (see above)');
  ok(`deployed → ${url}`);

  // 6. Verify + shell snippet --------------------------------------------------
  console.log(`\n${bold('6/6 Smoke test against the deployed URL')} (first run may wait on TLS)`);
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) break;
    } catch {
      /* cert still provisioning */
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const smoke = spawnSync('pnpm', ['smoke', '--', '--url', url], { stdio: 'inherit' });
  if (smoke.status !== 0) warn('smoke test failed — check `pnpm kompass status` and provider keys');

  const snippet = `
# Kompass — free-model gateway for Claude Code (added by kompass init)
claude-free() {
  ANTHROPIC_BASE_URL="${url}" \\
  ANTHROPIC_AUTH_TOKEN="${secrets.KOMPASS_BEARER}" \\
  ANTHROPIC_MODEL="claude-sonnet-4-5" \\
  claude "$@"
}
`;
  const rc = `${homedir()}/.zshrc`;
  const addIt = (await ask(`Add the claude-free() function to ${rc}? (y/n)`, 'y')).toLowerCase();
  if (addIt.startsWith('y')) {
    const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
    if (existing.includes(`ANTHROPIC_BASE_URL="${url}"`)) {
      ok('claude-free() already present — left as is');
    } else {
      appendFileSync(rc, snippet);
      ok(`appended claude-free() to ${rc} — run: source ${rc}`);
    }
  } else {
    console.log('  Paste this into your shell profile:');
    console.log(snippet);
  }

  console.log(`\n${bold('Done.')} Next steps:`);
  console.log(`  source ~/.zshrc && claude-free        # use it`);
  console.log(`  pnpm kompass status --url ${url}`);
  console.log(`  ${url}/status.html                    # live dashboard (enter your bearer once)`);
  rl.close();
}
