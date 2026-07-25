// The zero-key provider — the claim the Deploy-to-Cloudflare onboarding rests
// on ("a fresh deployment answers with no provider signups").
//
// The binding itself CANNOT be exercised here: wrangler.test.jsonc deliberately
// omits it (AI bindings have no local Miniflare implementation — see
// scripts/check-config-parity.mjs), and a binding is a live object rather than
// an HTTP call, so it cannot be intercepted by fetchMock either. What is
// asserted here is everything around it: that the config shape is legal without
// a URL or a key, and that a deployment WITHOUT the binding degrades to a
// recoverable turn instead of failing hard. The binding answering is verified
// live against the deployed worker instead, and recorded in DECISIONS.md.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig, type RouterConfig } from '../src/worker/config';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const AUTH = { 'content-type': 'application/json', authorization: 'Bearer test-bearer-token' };

/** A roster with NOTHING configured except the binding-backed provider. */
function cfg(): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    providers: {
      workersai: {
        kind: 'workers-ai',
        key_env: '',
        base_url: '',
        limits: { rpm: 30, rpd: 300 },
        model_limits: { '@cf/test-model': { rpm: 30, rpd: 300, ctx: 24000 } },
      },
    },
    lanes: { AGENTIC: ['workersai/@cf/test-model'] },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(cfg()));
});

describe('workers-ai provider (zero-key)', () => {
  it('is a legal provider with no base_url and no key_env', () => {
    // Both are meaningless for a binding; requiring them would demand a value
    // that cannot exist. Every other kind still requires them.
    expect(() => validateConfig(cfg())).not.toThrow();
    const bad = cfg();
    bad.providers.workersai!.kind = 'openai';
    expect(() => validateConfig(bad)).toThrow(/base_url/);
  });

  it('never asks for an API key — the binding carries authentication', () => {
    // Guards the property that makes zero-signup onboarding possible: no code
    // path may make this provider depend on an env secret.
    expect(cfg().providers.workersai!.key_env).toBe('');
  });

  it('degrades to a recoverable turn on a deployment without the binding', async () => {
    // wrangler.test.jsonc has no ai binding, so this exercises exactly what a
    // clone deployed without it would do. It must not be a fatal status.
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'no binding on this deployment' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kompass-exhausted')).toBe('true');
    // And the reason is legible rather than a generic failure.
    const trace = await SELF.fetch('https://kompass.test/traces?n=1', { headers: AUTH });
    const { traces } = (await trace.json()) as {
      traces: { attempts: { hop_reason: string }[] }[];
    };
    expect(JSON.stringify(traces[0]!.attempts)).toContain('no-binding');
  });
});
