// kompass CLI: deploy | status | logs | config push (BUILD_PLAN M1/M4).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { compileConfig } from './compile-config';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function baseUrl(): string {
  const url = flag('url') ?? process.env.KOMPASS_URL;
  if (!url) {
    console.error('Set --url or KOMPASS_URL (e.g. https://kompass.<you>.workers.dev)');
    process.exit(2);
  }
  return url.replace(/\/$/, '');
}

function bearer(): string {
  if (process.env.KOMPASS_BEARER) return process.env.KOMPASS_BEARER;
  try {
    return JSON.parse(readFileSync('secrets/.secrets.json', 'utf8')).KOMPASS_BEARER;
  } catch {
    console.error('No KOMPASS_BEARER env and secrets/.secrets.json unreadable');
    process.exit(2);
  }
}

async function configPush() {
  const cfg = compileConfig(flag('config-dir') ?? 'config');
  const res = await fetch(`${baseUrl()}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer()}` },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    console.error(`config push failed: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log(`config pushed (version ${cfg.version}) → ${baseUrl()}/config`);
}

async function status() {
  const res = await fetch(`${baseUrl()}/status`, {
    headers: { authorization: `Bearer ${bearer()}` },
  });
  if (!res.ok) {
    console.error(`status failed: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log(JSON.stringify(await res.json(), null, 2));
}

function deploy() {
  execSync('pnpm exec wrangler deploy', { stdio: 'inherit' });
  execSync('pnpm exec wrangler secret bulk secrets/.secrets.json', { stdio: 'inherit' });
}

function logs() {
  execSync('pnpm exec wrangler tail --format pretty', { stdio: 'inherit' });
}

const [, , cmd, sub] = process.argv;
if (cmd === 'config' && sub === 'push') await configPush();
else if (cmd === 'status') await status();
else if (cmd === 'deploy') deploy();
else if (cmd === 'logs') logs();
else {
  console.log('Usage: kompass <deploy|status|logs|config push> [--url <worker-url>]');
  process.exit(cmd ? 1 : 0);
}
