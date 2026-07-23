import { Hono } from 'hono';
import type { AnthropicRequest, OpenAIResponse } from '../adapters/types';
import {
  anthropicToOpenAI,
  openAIStreamToAnthropicStream,
  openAIToAnthropic,
} from '../adapters/openai';
import { bearerAuth } from './auth';
import type { Env } from './env';

// M0 bootstrap exception (BUILD_PLAN §6.5): single hardcoded model, replaced by the
// KV registry in M1. Slug verified live against GET openrouter.ai/api/v1/models
// on 2026-07-23 (1 active endpoint). Planned fallback qwen/qwen3-coder:free was
// dead-listed; live substitute chosen from the roster.
const M0_MODEL = 'poolside/laguna-s-2.1:free';
const M0_FALLBACK_MODEL = 'poolside/laguna-xs-2.1:free';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true, service: 'kompass' }));

app.use('*', bearerAuth);

app.post('/v1/messages', async (c) => {
  const body = (await c.req.json()) as AnthropicRequest;
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json(
      { type: 'error', error: { type: 'api_error', message: 'OPENROUTER_API_KEY not configured' } },
      500,
    );
  }

  for (const model of [M0_MODEL, M0_FALLBACK_MODEL]) {
    const openaiReq = anthropicToOpenAI(body, model);
    const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'http-referer': 'https://github.com/vinoth4v/kompass',
        'x-title': 'Kompass',
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.log(`upstream ${model} -> ${upstream.status}: ${errText.slice(0, 300)}`);
      continue; // try fallback
    }

    if (body.stream) {
      if (!upstream.body) continue;
      return new Response(openAIStreamToAnthropicStream(upstream.body, body.model), {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }
    const json = (await upstream.json()) as OpenAIResponse;
    return c.json(openAIToAnthropic(json, body.model));
  }

  // 529 (Anthropic "overloaded") is outside Hono's typed status union — build the Response directly.
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'all upstream models failed' },
    }),
    { status: 529, headers: { 'content-type': 'application/json' } },
  );
});

// Claude Code probes this for context tracking; a cheap estimate keeps it happy.
app.post('/v1/messages/count_tokens', async (c) => {
  const body = (await c.req.json()) as AnthropicRequest;
  const text = JSON.stringify(body.messages) + JSON.stringify(body.system ?? '');
  return c.json({ input_tokens: Math.ceil(text.length / 4) });
});

export default app;
