// Chain resolution + provider dispatch. M1: sequential fallback over the lane chain;
// M2 adds the Durable Object ledger/health/stickiness in front of this.
import type { AnthropicRequest, OpenAIResponse } from '../adapters/types';
import {
  anthropicToOpenAI,
  openAIStreamToAnthropicStream,
  openAIToAnthropic,
} from '../adapters/openai';
import {
  anthropicToGemini,
  geminiStreamToAnthropicStream,
  geminiToAnthropic,
  type GeminiResponse,
} from '../adapters/gemini';
import type { ProviderConfig, RouterConfig } from './config';
import { parseChainEntry } from './config';
import type { Env } from './env';

export interface RouteAttempt {
  entry: string;
  status: number | 'skipped-no-key' | 'skipped-disabled' | 'error';
  detail?: string;
}

export interface RouteOutcome {
  response: Response | null;
  attempts: RouteAttempt[];
  used?: string;
}

function providerKey(env: Env, p: ProviderConfig): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[p.key_env];
}

async function callOpenAI(
  p: ProviderConfig,
  key: string,
  body: AnthropicRequest,
  model: string,
): Promise<Response> {
  return fetch(`${p.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'http-referer': 'https://github.com/vinoth4v/kompass',
      'x-title': 'Kompass',
    },
    body: JSON.stringify(anthropicToOpenAI(body, model)),
  });
}

async function callGemini(
  p: ProviderConfig,
  key: string,
  body: AnthropicRequest,
  model: string,
): Promise<Response> {
  const verb = body.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return fetch(`${p.base_url}/models/${model}:${verb}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(anthropicToGemini(body)),
  });
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
};

/**
 * Try one chain entry. Returns an Anthropic-format Response on success, null on failure.
 */
export async function tryChainEntry(
  env: Env,
  cfg: RouterConfig,
  entry: string,
  body: AnthropicRequest,
  attempts: RouteAttempt[],
): Promise<Response | null> {
  const { provider, model } = parseChainEntry(entry);
  const p = cfg.providers[provider];
  if (!p) {
    attempts.push({ entry, status: 'error', detail: 'unknown provider' });
    return null;
  }
  if (p.enabled === false) {
    attempts.push({ entry, status: 'skipped-disabled' });
    return null;
  }
  const key = providerKey(env, p);
  if (!key) {
    attempts.push({ entry, status: 'skipped-no-key' });
    return null;
  }
  // Guardrail §6.8, enforced at request time as well as config-validation time.
  if (!cfg.allow_paid && provider === 'openrouter' && !model.endsWith(':free')) {
    attempts.push({ entry, status: 'error', detail: 'paid model blocked (allow_paid=false)' });
    return null;
  }

  try {
    const upstream =
      p.kind === 'gemini'
        ? await callGemini(p, key, body, model)
        : await callOpenAI(p, key, body, model);

    if (!upstream.ok) {
      const errText = (await upstream.text()).slice(0, 300);
      attempts.push({ entry, status: upstream.status, detail: errText });
      return null;
    }

    if (body.stream) {
      if (!upstream.body) {
        attempts.push({ entry, status: 'error', detail: 'no body' });
        return null;
      }
      const stream =
        p.kind === 'gemini'
          ? geminiStreamToAnthropicStream(upstream.body, body.model)
          : openAIStreamToAnthropicStream(upstream.body, body.model);
      attempts.push({ entry, status: 200 });
      return new Response(stream, { headers: SSE_HEADERS });
    }

    const json = await upstream.json();
    attempts.push({ entry, status: 200 });
    const translated =
      p.kind === 'gemini'
        ? geminiToAnthropic(json as GeminiResponse, body.model)
        : openAIToAnthropic(json as OpenAIResponse, body.model);
    return Response.json(translated);
  } catch (e) {
    attempts.push({ entry, status: 'error', detail: String(e).slice(0, 200) });
    return null;
  }
}

/**
 * Route a request down a lane's chain (or a forced "provider/model" override).
 */
export async function routeRequest(
  env: Env,
  cfg: RouterConfig,
  lane: string,
  body: AnthropicRequest,
  forcedEntry?: string,
): Promise<RouteOutcome> {
  const chain = forcedEntry
    ? [forcedEntry]
    : (cfg.lanes[lane] ?? cfg.lanes[cfg.default_lane] ?? []);
  const attempts: RouteAttempt[] = [];
  for (const entry of chain) {
    const res = await tryChainEntry(env, cfg, entry, body, attempts);
    if (res) return { response: res, attempts, used: entry };
  }
  return { response: null, attempts };
}
