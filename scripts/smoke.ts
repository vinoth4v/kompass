/**
 * Anthropic-protocol smoke harness (BUILD_PLAN M0).
 * Usage: pnpm smoke -- --url https://kompass.<you>.workers.dev
 *   or   BASE_URL=... KOMPASS_BEARER=... pnpm smoke
 * Sends (a) a streamed completion, (b) a tool-use round-trip shaped like Claude Code
 * traffic, (c) an unauthenticated request expecting 401.
 */
import { readFileSync } from 'node:fs';

const argUrl = process.argv.find((a, i) => process.argv[i - 1] === '--url');
const BASE_URL = (argUrl ?? process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

function loadBearer(): string {
  if (process.env.KOMPASS_BEARER) return process.env.KOMPASS_BEARER;
  try {
    const s = JSON.parse(readFileSync('secrets/.secrets.json', 'utf8'));
    return s.KOMPASS_BEARER;
  } catch {
    console.error('No KOMPASS_BEARER env var and secrets/.secrets.json unreadable');
    process.exit(2);
  }
}
const BEARER = loadBearer();

const HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${BEARER}`,
  'anthropic-version': '2023-06-01',
};

interface SSEEvent {
  event: string;
  data: any;
}

async function readSSE(res: Response): Promise<SSEEvent[]> {
  const text = await res.text();
  const events: SSEEvent[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) current = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      try {
        events.push({ event: current, data: JSON.parse(line.slice(5).trim()) });
      } catch {
        /* keep-alive */
      }
    }
  }
  return events;
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function testAuth() {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 16, messages: [] }),
  });
  check('401 without bearer', res.status === 401, `got ${res.status}`);
}

async function testStreaming() {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      // Generous budget: reasoning models spend tokens thinking before any text,
      // and Claude Code itself always sends large max_tokens.
      max_tokens: 2048,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    }),
  });
  if (res.status !== 200) {
    check('streamed completion', false, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const events = await readSSE(res);
  const kinds = events.map((e) => e.event);
  const text = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
  check(
    'streamed completion',
    kinds.includes('message_start') &&
      kinds.includes('content_block_delta') &&
      kinds.includes('message_stop') &&
      text.length > 0,
    `${Date.now() - t0}ms, text="${text.slice(0, 60)}"`,
  );
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather for a city',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

async function testToolRoundTrip(forced?: string) {
  const label = forced ? `tool round-trip [${forced}]` : 'tool round-trip';
  const headers = forced ? { ...HEADERS, 'x-kompass-model': forced } : HEADERS;
  // Turn 1: model should ask to call get_weather (streamed, like Claude Code does).
  const res1 = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      stream: true,
      tools: [WEATHER_TOOL],
      messages: [{ role: 'user', content: 'What is the weather in Berlin? Use the tool.' }],
    }),
  });
  if (res1.status !== 200) {
    check(label, false, `turn1 HTTP ${res1.status}: ${(await res1.text()).slice(0, 200)}`);
    return;
  }
  const events = await readSSE(res1);
  const toolStart = events.find(
    (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use',
  );
  if (!toolStart) {
    check(label, false, 'no tool_use block in turn 1');
    return;
  }
  const toolId = toolStart.data.content_block.id;
  const toolName = toolStart.data.content_block.name;
  const argsJson = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json)
    .join('');
  let args: any = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    check(label, false, `unparsable tool args: ${argsJson.slice(0, 100)}`);
    return;
  }

  // Turn 2: return a tool_result, expect a final text answer mentioning the value.
  const res2 = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      tools: [WEATHER_TOOL],
      messages: [
        { role: 'user', content: 'What is the weather in Berlin? Use the tool.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolId, name: toolName, input: args }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolId, content: '21°C, sunny, wind 8 km/h' },
          ],
        },
      ],
    }),
  });
  if (res2.status !== 200) {
    check(label, false, `turn2 HTTP ${res2.status}: ${(await res2.text()).slice(0, 200)}`);
    return;
  }
  const final = (await res2.json()) as any;
  const finalText = (final.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join(' ');
  check(
    label,
    toolName === 'get_weather' && typeof args.city === 'string' && /21|sunny/i.test(finalText),
    `tool=${toolName}(${JSON.stringify(args)}), final="${finalText.slice(0, 80)}"`,
  );
}

async function testDispatchLatency() {
  // M3 acceptance: p50 added latency < 400ms over 20 mixed requests.
  const small = (i: number) => ({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: `what does exit code ${i} mean in bash?` }],
  });
  const toolTask = (i: number) => ({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    tools: [WEATHER_TOOL],
    messages: [
      { role: 'user', content: `refactor module_${i}.py to use async io and update its tests` },
    ],
  });
  const big = () => ({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'summarize this: ' + 'lorem ipsum '.repeat(25_000) }],
  });
  // 10 heuristic-small, 4 distinct classifier tasks, those same 4 again (cache), 2 longctx
  const bodies = [
    ...Array.from({ length: 10 }, (_, i) => small(i)),
    ...Array.from({ length: 4 }, (_, i) => toolTask(i)),
    ...Array.from({ length: 4 }, (_, i) => toolTask(i)),
    big(),
    big(),
  ];
  const results: Array<{ lane: string; source: string; ms: number }> = [];
  for (const b of bodies) {
    const res = await fetch(`${BASE_URL}/dispatch/preview`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(b),
    });
    if (res.status !== 200) {
      check(
        'dispatcher p50 latency',
        false,
        `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`,
      );
      return;
    }
    results.push((await res.json()) as any);
  }
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)]!;
  const bySource = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});
  check(
    'dispatcher p50 latency <400ms',
    p50 < 400,
    `p50=${p50}ms max=${sorted[sorted.length - 1]}ms sources=${JSON.stringify(bySource)}`,
  );
}

async function testLongContext() {
  // M6 (BUILD_PLAN_V2 §5): a >60k-token request must be routed and answered
  // (not dropped) — proves the fit filter's per-model ctx checks and the
  // derived LONGCTX heuristic threshold both work against the REAL deployed
  // config, not just unit fixtures. ~300k chars / 4 ≈ 75k tokens.
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content:
            'lorem ipsum dolor sit amet '.repeat(11_000) + '\n\nReply with exactly the word: pong',
        },
      ],
    }),
  });
  if (res.status !== 200) {
    check('>60k-token request', false, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const served = res.headers.get('x-kompass-served-by');
  const lane = res.headers.get('x-kompass-lane');
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  const text = (json.content ?? []).map((b) => b.text ?? '').join('');
  // A non-null served_by proves a real model answered — `lane` is always set
  // even on the exhausted-notice fallback, so checking `served` (not just
  // "text.length > 0", which the synthetic notice also satisfies) is what
  // actually proves the fit filter + derived LONGCTX threshold routed for real.
  check(
    '>60k-token request routes and answers',
    served !== null && text.length > 0,
    `${Date.now() - t0}ms, lane=${lane} served_by=${served}, text="${text.slice(0, 60)}"`,
  );
}

async function testTraceStore() {
  // M7: a routed request gets a trace id back, and that trace is fetchable and
  // redacted by default (no raw_body unless X-Kompass-Trace: full was sent).
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'trace smoke check — reply with: pong' }],
    }),
  });
  const traceId = res.headers.get('x-kompass-trace-id');
  if (res.status !== 200 || !traceId) {
    check('trace store', false, `HTTP ${res.status}, trace-id header=${traceId}`);
    return;
  }
  const traceRes = await fetch(`${BASE_URL}/trace/${traceId}`, { headers: HEADERS });
  if (traceRes.status !== 200) {
    check('trace store', false, `GET /trace/${traceId} → HTTP ${traceRes.status}`);
    return;
  }
  const trace = (await traceRes.json()) as { id: string; raw_body?: string; digest: string };
  check(
    'trace store: fetchable, redacted by default',
    trace.id === traceId && trace.raw_body === undefined && typeof trace.digest === 'string',
    `id=${trace.id}, has_raw_body=${trace.raw_body !== undefined}`,
  );
  const listRes = await fetch(`${BASE_URL}/traces?n=5`, { headers: HEADERS });
  const { traces } = (await listRes.json()) as { traces: unknown[] };
  check('trace store: /traces lists recent entries', traces.length > 0, `n=${traces.length}`);
}

async function testAdaptiveScoring() {
  // M8: /status exposes a per-(lane,entry) adaptive score cell for every
  // model that has actually been dispatched — sanity-check the shape after
  // the tool round-trip above has already exercised at least one real route.
  const res = await fetch(`${BASE_URL}/status`, { headers: HEADERS });
  if (res.status !== 200) {
    check('adaptive scoring', false, `GET /status → HTTP ${res.status}`);
    return;
  }
  const { scores } = (await res.json()) as {
    scores: Record<string, { health: number; attempts: number; demoted: boolean }>;
  };
  const entries = Object.entries(scores ?? {});
  const wellFormed = entries.every(
    ([k, v]) => k.includes(':') && typeof v.health === 'number' && typeof v.demoted === 'boolean',
  );
  check(
    'adaptive scoring: /status exposes well-formed score cells',
    entries.length > 0 && wellFormed,
    `${entries.length} cells`,
  );
}

console.log(`Smoke target: ${BASE_URL}`);
await testAuth();
await testStreaming();
await testToolRoundTrip();
await testDispatchLatency();
await testLongContext();
await testTraceStore();
await testAdaptiveScoring();
// M1 acceptance: identical toy tool-call task on one OpenAI-format and one Gemini model.
const adapterTargets = (process.env.SMOKE_ADAPTER_MODELS ?? '').split(',').filter(Boolean);
for (const target of adapterTargets) await testToolRoundTrip(target);
if (failures > 0) {
  console.error(`\n${failures} smoke check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll smoke checks passed');
