// kompass trace <id> | trace list [--n N] | trace replay <id> [--lane L] [--model M]
// (BUILD_PLAN_V2 M7). NOTE: the existing `kompass logs` command already means
// "live-tail wrangler logs" — the M7 task list's "kompass logs --last N" phrasing
// would collide with that, so recent-trace listing lives at `kompass trace list`
// instead (see docs/DECISIONS.md).
import { readFileSync } from 'node:fs';

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

interface TraceAttempt {
  model: string;
  outcome: 'ok' | 'fail';
  hop_reason: string;
  latency_ms?: number;
}

interface TraceRecord {
  id: string;
  session?: string;
  ts: number;
  lane: string;
  verdict: string;
  confidence?: number;
  est_in: number;
  chain_considered: string[];
  attempts: TraceAttempt[];
  final_model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  digest: string;
  raw_body?: string;
  exp?: number;
}

function printTrace(t: TraceRecord) {
  console.log(`trace ${t.id}  ${new Date(t.ts).toLocaleString()}`);
  console.log(
    `  lane=${t.lane}  verdict=${t.verdict}${t.confidence !== undefined ? ` (${t.confidence.toFixed(2)})` : ''}  est_in=${t.est_in}`,
  );
  console.log(`  session=${t.session ?? '(none)'}  digest=${t.digest}`);
  console.log(`  chain considered: ${t.chain_considered.join(' → ')}`);
  console.log(`  final_model: ${t.final_model ?? '(none — every attempt failed)'}`);
  if (t.usage) console.log(`  usage: in=${t.usage.input_tokens} out=${t.usage.output_tokens}`);
  console.log('  attempts:');
  for (const a of t.attempts) {
    console.log(
      `    ${a.outcome === 'ok' ? '✓' : '✗'} ${a.model}${a.latency_ms !== undefined ? ` ${a.latency_ms}ms` : ''}  [${a.hop_reason}]`,
    );
  }
  console.log(
    t.raw_body !== undefined
      ? `  full capture: raw body stored (${t.raw_body.length} chars)${t.exp ? `, expires ${new Date(t.exp).toLocaleString()}` : ''}`
      : '  full capture: not requested for this trace (redacted only — see X-Kompass-Trace: full)',
  );
}

export async function traceShow(id: string | undefined) {
  if (!id) {
    console.error('Usage: kompass trace <id>');
    process.exit(2);
  }
  const res = await fetch(`${baseUrl()}/trace/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${bearer()}` },
  });
  if (!res.ok) {
    console.error(`trace fetch failed: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  if (process.argv.includes('--json')) {
    console.log(await res.text());
    return;
  }
  printTrace((await res.json()) as TraceRecord);
}

export async function traceList() {
  const n = flag('n') ?? '20';
  const res = await fetch(`${baseUrl()}/traces?n=${encodeURIComponent(n)}`, {
    headers: { authorization: `Bearer ${bearer()}` },
  });
  if (!res.ok) {
    console.error(`trace list failed: HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const { traces } = (await res.json()) as { traces: TraceRecord[] };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(traces, null, 2));
    return;
  }
  if (!traces.length) {
    console.log('No traces yet.');
    return;
  }
  for (const t of traces) {
    const time = new Date(t.ts).toLocaleTimeString([], { hour12: false });
    const okCount = t.attempts.filter((a) => a.outcome === 'ok').length;
    console.log(
      `  ${time}  ${t.id}  ${t.lane.padEnd(8)} ${t.final_model ?? '(no route)'}  ${okCount}/${t.attempts.length} ok`,
    );
  }
}

/** Re-issues a stored full-capture trace's raw body against a different route.
 *  Requires the trace to have been captured with X-Kompass-Trace: full — a
 *  redacted-only trace never stored the body, so replay can't reconstruct it. */
export async function traceReplay(id: string | undefined) {
  if (!id) {
    console.error('Usage: kompass trace replay <id> [--lane L] [--model M]');
    process.exit(2);
  }
  const traceRes = await fetch(`${baseUrl()}/trace/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${bearer()}` },
  });
  if (!traceRes.ok) {
    console.error(`trace fetch failed: HTTP ${traceRes.status}: ${await traceRes.text()}`);
    process.exit(1);
  }
  const trace = (await traceRes.json()) as TraceRecord;
  if (trace.raw_body === undefined) {
    console.error(
      `trace ${id} has no stored body — it wasn't captured with X-Kompass-Trace: full ` +
        '(or its 1h capture window has expired). Replay needs the original request bytes.',
    );
    process.exit(1);
  }
  const lane = flag('lane');
  const model = flag('model');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer()}`,
  };
  if (lane) headers['x-kompass-lane'] = lane;
  if (model) headers['x-kompass-model'] = model;
  const res = await fetch(`${baseUrl()}/v1/messages`, {
    method: 'POST',
    headers,
    body: trace.raw_body,
  });
  console.log(
    `replayed trace ${id}${lane ? ` [lane=${lane}]` : ''}${model ? ` [model=${model}]` : ''}`,
  );
  console.log(`  → HTTP ${res.status}, served-by=${res.headers.get('x-kompass-served-by') ?? '?'}`);
  if (process.argv.includes('--json')) {
    console.log(await res.text());
  }
}
