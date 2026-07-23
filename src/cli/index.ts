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

interface StatusPayload {
  lanes: Record<string, string[]>;
  default_lane?: string;
  providers: Record<
    string,
    {
      enabled: boolean;
      has_key: boolean;
      rpm: { used: number; limit: number };
      rpd: { used: number; limit: number };
    }
  >;
  cooldowns: Record<string, string>;
  routes: Array<{
    ts: number;
    lane: string;
    entry: string;
    ok: boolean;
    ms?: number;
    detail?: string;
  }>;
}

async function status() {
  const res = await fetch(`${baseUrl()}/status`, {
    headers: { authorization: `Bearer ${bearer()}` },
  });
  if (!res.ok) {
    console.error(`status failed: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const d = (await res.json()) as StatusPayload;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  console.log('Providers');
  for (const [name, p] of Object.entries(d.providers)) {
    const state = !p.enabled ? 'disabled' : !p.has_key ? 'no-key' : 'live';
    console.log(
      `  ${name.padEnd(12)} ${state.padEnd(9)} rpm ${p.rpm.used}/${p.rpm.limit}  rpd ${p.rpd.used}/${p.rpd.limit}`,
    );
  }
  console.log('Lanes');
  for (const [lane, chain] of Object.entries(d.lanes)) {
    const mark = lane === d.default_lane ? '*' : ' ';
    console.log(`  ${mark}${lane.padEnd(8)} ${chain.join(' → ')}`);
  }
  const cds = Object.entries(d.cooldowns);
  if (cds.length) {
    console.log('Cooldowns');
    for (const [m, t] of cds) console.log(`  ${m} (${t} left)`);
  }
  console.log(`Last ${d.routes.length} routes`);
  for (const r of d.routes.slice(0, 50)) {
    const time = new Date(r.ts).toISOString().slice(11, 19);
    console.log(
      `  ${time} ${r.ok ? '✓' : '✗'} ${r.lane.padEnd(8)} ${r.entry}${r.ms !== undefined ? ` ${r.ms}ms` : ''}${r.detail ? `  [${r.detail}]` : ''}`,
    );
  }
}

function deploy() {
  execSync('pnpm exec wrangler deploy', { stdio: 'inherit' });
  execSync('pnpm exec wrangler secret bulk secrets/.secrets.json', { stdio: 'inherit' });
}

function logs() {
  execSync('pnpm exec wrangler tail --format pretty', { stdio: 'inherit' });
}

/**
 * M5 bench stub (SPEC P1 #11): run test/tasks/*.md through the deployed router,
 * optionally once per lane (--lanes FAST,AGENTIC), print a results table.
 */
async function bench() {
  const { readdirSync } = await import('node:fs');
  const dir = 'test/tasks';
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const lanesFlag = flag('lanes');
  const lanes = lanesFlag ? lanesFlag.split(',') : [undefined];
  const rows: string[][] = [];
  for (const file of files) {
    const task = readFileSync(`${dir}/${file}`, 'utf8').trim();
    for (const lane of lanes) {
      const t0 = Date.now();
      let ok = false;
      let note = '';
      try {
        const res = await fetch(`${baseUrl()}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearer()}`,
            ...(lane ? { 'x-kompass-lane': lane } : {}),
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1024,
            messages: [{ role: 'user', content: task }],
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            content?: Array<{ type: string; text?: string }>;
          };
          const text = (json.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
          ok = text.length > 40;
          note = `${text.length} chars`;
        } else {
          note = `HTTP ${res.status}`;
        }
      } catch (e) {
        note = String(e).slice(0, 60);
      }
      rows.push([file, lane ?? '(auto)', ok ? '✓' : '✗', `${Date.now() - t0}ms`, note]);
      console.error(`  ran ${file} [${lane ?? 'auto'}] → ${ok ? 'ok' : 'FAIL'}`);
    }
  }
  console.log('\n| task | lane | ok | latency | note |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
}

const [, , cmd, sub] = process.argv;
if (cmd === 'init') await (await import('./init')).init();
else if (cmd === 'config' && sub === 'push') await configPush();
else if (cmd === 'status') await status();
else if (cmd === 'deploy') deploy();
else if (cmd === 'logs') logs();
else if (cmd === 'bench') await bench();
else {
  console.log('Usage: kompass <init|deploy|status|logs|bench|config push> [--url <worker-url>]');
  process.exit(cmd ? 1 : 0);
}
