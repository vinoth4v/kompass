import { Hono } from 'hono';
import type { AnthropicRequest } from '../adapters/types';
import { bearerAuth } from './auth';
import { CONFIG_KV_KEY, loadConfig, validateConfig } from './config';
import type { Env } from './env';
import { routeRequest } from './router';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true, service: 'kompass' }));

app.use('*', bearerAuth);

function anthropicError(type: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

app.post('/v1/messages', async (c) => {
  const body = (await c.req.json()) as AnthropicRequest;
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) {
    return anthropicError('api_error', 'no config in KV — run `kompass config push`', 503);
  }

  // Test/debug override: force a specific "provider/model" chain entry.
  const forced = c.req.header('x-kompass-model') ?? undefined;

  // Lane selection: M3 adds the dispatcher; until then everything rides the default lane.
  const lane = cfg.default_lane;

  const outcome = await routeRequest(c.env, cfg, lane, body, forced);
  if (outcome.response) {
    console.log(JSON.stringify({ route: outcome.used, lane, attempts: outcome.attempts.length }));
    return outcome.response;
  }
  console.log(JSON.stringify({ route: null, lane, attempts: outcome.attempts }));
  return anthropicError(
    'overloaded_error',
    `all chain entries failed: ${outcome.attempts.map((a) => `${a.entry}→${a.status}`).join(', ')}`,
    529,
  );
});

app.post('/v1/messages/count_tokens', async (c) => {
  const body = (await c.req.json()) as AnthropicRequest;
  const text = JSON.stringify(body.messages) + JSON.stringify(body.system ?? '');
  return c.json({ input_tokens: Math.ceil(text.length / 4) });
});

// Hot-reload: the CLI compiles config/*.yaml → JSON and POSTs it here (SPEC P0 #4).
app.post('/config', async (c) => {
  let candidate: unknown;
  try {
    candidate = await c.req.json();
  } catch {
    return anthropicError('invalid_request_error', 'config body must be JSON', 400);
  }
  try {
    validateConfig(candidate);
  } catch (e) {
    return anthropicError('invalid_request_error', `invalid config: ${String(e)}`, 400);
  }
  await c.env.CONFIG.put(CONFIG_KV_KEY, JSON.stringify(candidate));
  return c.json({ ok: true });
});

app.get('/config', async (c) => {
  const cfg = await loadConfig(c.env.CONFIG);
  if (!cfg) return anthropicError('not_found_error', 'no config pushed yet', 404);
  return c.json(cfg);
});

export default app;
