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
  lanes: Record<string, { chain: string[]; spread_top: number }>;
  default_lane?: string;
  providers: Record<
    string,
    {
      enabled: boolean;
      has_key: boolean;
      rpm: { used: number; limit: number };
      rpd: { used: number; limit: number };
      tokens_today?: { in: number; out: number };
    }
  >;
  perf?: Record<string, { ok: number; fail: number; rate: number }>;
  cooldowns: Record<string, string>;
  routes: Array<{
    ts: number;
    lane: string;
    entry: string;
    ok: boolean;
    ms?: number;
    detail?: string;
    tin?: number;
    tout?: number;
  }>;
  cloudflare: {
    workers: {
      requests: number;
      cpuTimeMsP50: number;
      cpuTimeMsP99: number;
      errors: number;
      subrequests: number;
      requestsLimit: number;
      cpuMsPerRequestLimit: number;
    };
    durableObjects: { requests: number; errors: number; wallTimeMsTotal: number };
    kv: {
      reads: number;
      writes: number;
      storageBytes: number;
      readsLimit: number;
      writesLimit: number;
      storageLimit: number;
    };
  } | null;
  deprecated_models?: Record<string, { replaced_by: string; note?: string; since?: string }>;
  disabled_models?: string[];
}

function fmtTok(n?: number): string {
  if (n === undefined) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
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
  if (d.cloudflare) {
    const cf = d.cloudflare;
    const pct = (u: number, l: number) => `${((u / l) * 100).toFixed(1)}%`;
    console.log("Cloudflare platform utilization (Kompass's own free-plan headroom, today UTC)");
    console.log(
      `  Workers requests   ${cf.workers.requests}/${cf.workers.requestsLimit} (${pct(cf.workers.requests, cf.workers.requestsLimit)})`,
    );
    console.log(
      `  Worker CPU/request  p50 ${cf.workers.cpuTimeMsP50}ms · p99 ${cf.workers.cpuTimeMsP99}ms (limit ${cf.workers.cpuMsPerRequestLimit}ms)${cf.workers.cpuTimeMsP99 >= cf.workers.cpuMsPerRequestLimit ? '  ⚠ hitting the CPU ceiling' : ''}`,
    );
    console.log(
      `  Worker errors       ${cf.workers.errors} (${cf.workers.subrequests} subrequests)`,
    );
    console.log(
      `  Durable Objects     ${cf.durableObjects.requests} requests, ${cf.durableObjects.errors} errors, ${(cf.durableObjects.wallTimeMsTotal / 1000).toFixed(1)}s wall time`,
    );
    console.log(
      `  KV reads            ${cf.kv.reads}/${cf.kv.readsLimit} (${pct(cf.kv.reads, cf.kv.readsLimit)})`,
    );
    console.log(
      `  KV writes           ${cf.kv.writes}/${cf.kv.writesLimit} (${pct(cf.kv.writes, cf.kv.writesLimit)})`,
    );
    console.log(
      `  KV storage          ${(cf.kv.storageBytes / 1e6).toFixed(2)}MB / ${(cf.kv.storageLimit / 1e9).toFixed(0)}GB`,
    );
  } else {
    console.log(
      'Cloudflare platform utilization: not configured (set CLOUDFLARE_API_TOKEN secret)',
    );
  }
  console.log('Providers');
  for (const [name, p] of Object.entries(d.providers)) {
    const state = !p.enabled ? 'disabled' : !p.has_key ? 'no-key' : 'live';
    const tok = p.tokens_today
      ? `  tokens ${fmtTok(p.tokens_today.in)}→${fmtTok(p.tokens_today.out)}`
      : '';
    console.log(
      `  ${name.padEnd(12)} ${state.padEnd(9)} rpm ${p.rpm.used}/${p.rpm.limit}  rpd ${p.rpd.used}/${p.rpd.limit}${tok}`,
    );
  }
  const depEntries = Object.entries(d.deprecated_models ?? {});
  if (depEntries.length) {
    console.log('Deprecated models (auto-substituted at every config push)');
    for (const [old, info] of depEntries) {
      console.log(`  ${old} → ${info.replaced_by}${info.note ? `  (${info.note})` : ''}`);
    }
  }
  if (d.disabled_models?.length) {
    console.log('Disabled models (kompass models enable <entry> to restore)');
    for (const m of d.disabled_models) console.log(`  ${m}`);
  }
  console.log('Lanes');
  for (const [lane, l] of Object.entries(d.lanes)) {
    const mark = lane === d.default_lane ? '*' : ' ';
    const spread = l.spread_top > 1 ? ` (spread top ${l.spread_top})` : '';
    console.log(`  ${mark}${lane.padEnd(8)}${spread} ${l.chain.join(' → ')}`);
  }
  if (d.perf && Object.keys(d.perf).length) {
    console.log('Model reliability (recent)');
    const rows = Object.entries(d.perf).sort((a, b) => a[1].rate - b[1].rate);
    for (const [entry, p] of rows) {
      console.log(`  ${String(p.rate).padStart(3)}%  ${entry}  (${p.ok}/${p.fail})`);
    }
  }
  const cds = Object.entries(d.cooldowns);
  if (cds.length) {
    console.log('Cooldowns');
    for (const [m, t] of cds) console.log(`  ${m} (${t} left)`);
  }
  console.log(`Last ${d.routes.length} routes`);
  for (const r of d.routes.slice(0, 50)) {
    const time = new Date(r.ts).toLocaleTimeString([], { hour12: false });
    const tok = r.tin !== undefined ? ` ${fmtTok(r.tin)}→${fmtTok(r.tout)} tok` : '';
    console.log(
      `  ${time} ${r.ok ? '✓' : '✗'} ${r.lane.padEnd(8)} ${r.entry}${r.ms !== undefined ? ` ${r.ms}ms` : ''}${tok}${r.detail ? `  [${r.detail}]` : ''}`,
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

interface DiscoveryPayload {
  ts: number;
  providers: Record<
    string,
    { liveCount: number; unconfigured: string[]; newSinceLast: string[]; error?: string }
  >;
}

/**
 * Prints the daily model-discovery report. `--run` triggers a fresh check instead
 * of reading the cached one (the cron already runs this once a day automatically).
 */
async function discovery() {
  const run = process.argv.includes('--run');
  const res = await fetch(`${baseUrl()}/discovery${run ? '/run' : ''}`, {
    method: run ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${bearer()}` },
  });
  if (!res.ok) {
    console.error(`discovery failed: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const d = (await res.json()) as DiscoveryPayload;
  console.log(`Discovery — last run ${new Date(d.ts).toLocaleString()}`);
  for (const [name, p] of Object.entries(d.providers)) {
    if (p.error) {
      console.log(`  ${name.padEnd(12)} ERROR: ${p.error}`);
      continue;
    }
    console.log(`  ${name.padEnd(12)} ${p.liveCount} live models`);
    if (p.newSinceLast.length) console.log(`    🆕 new: ${p.newSinceLast.join(', ')}`);
    if (p.unconfigured.length)
      console.log(
        `    unconfigured: ${p.unconfigured.slice(0, 10).join(', ')}${p.unconfigured.length > 10 ? ' …' : ''}`,
      );
  }
  console.log(
    '\nDetect-only — nothing was added to config. Verify a candidate live (roster + tool-calling)',
  );
  console.log('before adding it to config/lanes.yaml and running `kompass config push`.');
}

const [, , cmd, sub, arg3] = process.argv;
if (cmd === 'init') await (await import('./init')).init();
else if (cmd === 'ui') await import('../ui/server');
else if (cmd === 'config' && sub === 'push') await configPush();
else if (cmd === 'status') await status();
else if (cmd === 'deploy') deploy();
else if (cmd === 'logs') logs();
else if (cmd === 'bench') await bench();
else if (cmd === 'discovery') await discovery();
else if (cmd === 'deprecate')
  (await import('./deprecate')).deprecateModel(flag('config-dir') ?? 'config');
else if (cmd === 'models' && sub === 'disable')
  (await import('./models')).disableModel(arg3, flag('config-dir') ?? 'config');
else if (cmd === 'models' && sub === 'enable')
  (await import('./models')).enableModel(arg3, flag('config-dir') ?? 'config');
else if (cmd === 'models' && (sub === 'list' || !sub))
  (await import('./models')).listModels(flag('config-dir') ?? 'config');
else if (cmd === 'trace' && sub === 'list') await (await import('./trace')).traceList();
else if (cmd === 'trace' && sub === 'replay') await (await import('./trace')).traceReplay(arg3);
else if (cmd === 'trace') await (await import('./trace')).traceShow(sub);
else {
  console.log(
    'Usage: kompass <init|ui|deploy|status|logs|bench|discovery [--run]|deprecate <old> --replaced-by <new>|models <list|disable|enable> <entry>|trace <id>|trace list [--n N]|trace replay <id> [--lane L] [--model M]|config push> [--url <worker-url>]',
  );
  process.exit(cmd ? 1 : 0);
}
