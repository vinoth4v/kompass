// Non-chat capabilities (2026-07-24): per-model multimodal routing, image
// generation (/v1/images/generations) and embeddings (/v1/embeddings).
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RouterConfig } from '../src/worker/config';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-bearer-token',
};

const CF_BASE = 'https://api.cloudflare.com';
const CF_PATH_PREFIX = '/client/v4/accounts/test-account/ai';

function cfg(): RouterConfig {
  return {
    default_lane: 'SIMPLE',
    allow_paid: false,
    providers: {
      openrouter: {
        kind: 'openai',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        limits: { rpm: 100, rpd: 5000 },
        // Per-model capability: the provider stays text-only by default.
        multimodal_models: ['vl-model:free'],
      },
      cfai: {
        kind: 'openai',
        base_url: `${CF_BASE}${CF_PATH_PREFIX}/v1`,
        key_env: 'CF_WORKERS_AI_KEY',
        limits: { rpm: 100, rpd: 5000 },
      },
      google: {
        kind: 'gemini',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        key_env: 'GOOGLE_AI_KEY',
        multimodal: true,
        limits: { rpm: 100, rpd: 5000 },
      },
    },
    lanes: {
      SIMPLE: ['openrouter/text-model:free', 'openrouter/vl-model:free'],
    },
    images: {
      chain: ['cfai/@cf/black-forest-labs/flux-1-schnell', 'cfai/@cf/bytedance/sdxl-lightning'],
    },
    embeddings: {
      chain: ['cfai/@cf/baai/bge-m3', 'google/gemini-embedding-001'],
    },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('per-model multimodal routing', () => {
  it('an image request skips text-only models but reaches a multimodal_models entry', async () => {
    // Only the vl-model interceptor exists — a request to text-model would throw.
    fetchMock
      .get('https://openrouter.ai')
      .intercept({
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: (b) => JSON.parse(b as string).model === 'vl-model:free',
      })
      .reply(200, {
        choices: [
          { message: { role: 'assistant', content: 'a red square' }, finish_reason: 'stop' },
        ],
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'kompass-simple',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
              { type: 'text', text: 'describe this image' },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).content[0].text).toBe('a red square');
  });
});

describe('/v1/images/generations', () => {
  it('serves a flux-style JSON base64 image', async () => {
    fetchMock
      .get(CF_BASE)
      .intercept({
        path: `${CF_PATH_PREFIX}/run/@cf/black-forest-labs/flux-1-schnell`,
        method: 'POST',
      })
      .reply(
        200,
        { result: { image: 'ZmFrZWpwZWc=' }, success: true },
        { headers: { 'content-type': 'application/json' } },
      );
    const res = await SELF.fetch('https://kompass.test/v1/images/generations', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ prompt: 'a tiny compass' }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.data[0].b64_json).toBe('ZmFrZWpwZWc=');
    expect(j.model).toBe('cfai/@cf/black-forest-labs/flux-1-schnell');
    expect(j.mime_type).toBe('image/jpeg');
  });

  it('falls through to an SDXL-style binary image on failure', async () => {
    fetchMock
      .get(CF_BASE)
      .intercept({
        path: `${CF_PATH_PREFIX}/run/@cf/black-forest-labs/flux-1-schnell`,
        method: 'POST',
      })
      .reply(500, 'boom');
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    fetchMock
      .get(CF_BASE)
      .intercept({ path: `${CF_PATH_PREFIX}/run/@cf/bytedance/sdxl-lightning`, method: 'POST' })
      .reply(200, pngBytes.buffer, { headers: { 'content-type': 'image/png' } });
    const res = await SELF.fetch('https://kompass.test/v1/images/generations', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ prompt: 'a tiny compass' }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.model).toBe('cfai/@cf/bytedance/sdxl-lightning');
    expect(j.mime_type).toBe('image/png');
    expect(atob(j.data[0].b64_json)).toBe('\x89PNG');
  });

  it('400s without a prompt and 501s when unconfigured', async () => {
    const bad = await SELF.fetch('https://kompass.test/v1/images/generations', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const noCap = cfg();
    delete noCap.images;
    await env.CONFIG.put('config', JSON.stringify(noCap));
    const res = await SELF.fetch('https://kompass.test/v1/images/generations', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(res.status).toBe(501);
  });
});

describe('/v1/embeddings', () => {
  it('serves Workers AI bge-m3 vectors in OpenAI shape', async () => {
    fetchMock
      .get(CF_BASE)
      .intercept({ path: `${CF_PATH_PREFIX}/run/@cf/baai/bge-m3`, method: 'POST' })
      .reply(
        200,
        {
          result: {
            data: [
              [0.1, 0.2],
              [0.3, 0.4],
            ],
          },
          success: true,
        },
        { headers: { 'content-type': 'application/json' } },
      );
    const res = await SELF.fetch('https://kompass.test/v1/embeddings', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ input: ['hello', 'world'] }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.object).toBe('list');
    expect(j.data).toHaveLength(2);
    expect(j.data[1]).toEqual({ object: 'embedding', index: 1, embedding: [0.3, 0.4] });
    expect(j.model).toBe('cfai/@cf/baai/bge-m3');
  });

  it('falls through to gemini batchEmbedContents and accepts a bare string input', async () => {
    fetchMock
      .get(CF_BASE)
      .intercept({ path: `${CF_PATH_PREFIX}/run/@cf/baai/bge-m3`, method: 'POST' })
      .reply(429, 'rate limited');
    fetchMock
      .get('https://generativelanguage.googleapis.com')
      .intercept({
        path: '/v1beta/models/gemini-embedding-001:batchEmbedContents',
        method: 'POST',
      })
      .reply(200, { embeddings: [{ values: [1, 2, 3] }] });
    const res = await SELF.fetch('https://kompass.test/v1/embeddings', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ input: 'hello' }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.data[0].embedding).toEqual([1, 2, 3]);
    expect(j.model).toBe('google/gemini-embedding-001');
  });

  it('400s on missing input', async () => {
    const res = await SELF.fetch('https://kompass.test/v1/embeddings', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ input: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('skips a disabled chain entry and falls through', async () => {
    const disabledCfg = cfg();
    disabledCfg.disabled_models = ['cfai/@cf/baai/bge-m3'];
    await env.CONFIG.put('config', JSON.stringify(disabledCfg));
    // Only the gemini interceptor exists — hitting cfai would throw (assertNoPendingInterceptors).
    fetchMock
      .get('https://generativelanguage.googleapis.com')
      .intercept({
        path: '/v1beta/models/gemini-embedding-001:batchEmbedContents',
        method: 'POST',
      })
      .reply(200, { embeddings: [{ values: [9] }] });
    const res = await SELF.fetch('https://kompass.test/v1/embeddings', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ input: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).model).toBe('google/gemini-embedding-001');
  });
});
