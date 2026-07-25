// Encrypted provider-key vault. The properties that matter are security
// properties, so they are asserted directly rather than inferred from a
// round-trip working.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
import {
  deleteProviderKey,
  getProviderKey,
  listProviderKeys,
  loadVaultKeys,
  maskKey,
  putProviderKey,
  vaultAvailable,
} from '../src/worker/vault';

const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
// vitest.config.ts binds this; a deployment without it has the vault disabled.
// Bound in vitest.config.ts, so the Worker under test shares it — the vault has
// to be enabled INSIDE the worker for SELF.fetch paths, not just in this file.
const withMaster = env;

/** The DO stub that now stores vault entries — see the DO's vault section. */
const store = () => env.KOMPASS_STATE.get(env.KOMPASS_STATE.idFromName('global'));

describe('provider key vault', () => {
  it('round-trips a key through encryption', async () => {
    await putProviderKey(withMaster, store(), 'openrouter', KEY);
    expect(await getProviderKey(withMaster, store(), 'openrouter')).toBe(KEY);
  });

  it('never stores the key in plaintext', async () => {
    await putProviderKey(withMaster, store(), 'nvidia', KEY);
    // Read the raw stored blob straight out of DO storage — what an attacker
    // with read access to the durable object would see.
    const raw = (await store().vaultGet('nvidia')) as { ct: string; iv: string } | null;
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('sk-or-v1-abcdefgh');
    expect(raw!.ct.length).toBeGreaterThan(0);
    expect(raw!.iv.length).toBeGreaterThan(0);
  });

  it('uses a fresh nonce per write — GCM nonce reuse leaks the keystream', async () => {
    // Read the raw stored blob back through the DO, which is where entries live
    // now — KV was abandoned because it is not read-after-write consistent.
    const read = async () => (await store().vaultGet('a')) as { iv: string; ct: string };
    await putProviderKey(withMaster, store(), 'a', KEY);
    const first = await read();
    await putProviderKey(withMaster, store(), 'a', KEY);
    const second = await read();
    expect(second.iv).not.toBe(first.iv);
    // Same plaintext, same key, different nonce => different ciphertext.
    expect(second.ct).not.toBe(first.ct);
  });

  it('reports a key as absent rather than throwing when it cannot decrypt', async () => {
    await putProviderKey(withMaster, store(), 'groq', KEY);
    const rotated = { ...withMaster, KOMPASS_MASTER_KEY: 'a-different-master-key' } as typeof env;
    // A rotated master key must not take the gateway down — the key simply
    // looks unconfigured and the router routes elsewhere.
    expect(await getProviderKey(rotated, store(), 'groq')).toBeNull();
  });

  it('is disabled, not broken, without a master key', async () => {
    const noMaster = { ...env, KOMPASS_MASTER_KEY: undefined } as unknown as typeof env;
    expect(vaultAvailable(noMaster)).toBe(false);
    expect(await getProviderKey(noMaster, store(), 'openrouter')).toBeNull();
    expect(await loadVaultKeys(noMaster, store())).toEqual({});
  });

  it('listing exposes only masked values', async () => {
    await putProviderKey(withMaster, store(), 'mistral', KEY);
    const list = await listProviderKeys(withMaster, store());
    expect(list.mistral!.masked).toBe('sk-or-v1…6789');
    expect(JSON.stringify(list)).not.toContain(KEY);
  });

  it('masks short keys without revealing most of them', () => {
    expect(maskKey('short')).toBe('sh…rt');
    expect(maskKey(KEY)).toBe('sk-or-v1…6789');
  });

  it('deletes', async () => {
    await putProviderKey(withMaster, store(), 'cohere', KEY);
    await deleteProviderKey(store(), 'cohere');
    expect(await getProviderKey(withMaster, store(), 'cohere')).toBeNull();
  });
});

describe('vault inventory does not depend on KV list()', () => {
  it('a stored key appears in the listing immediately', async () => {
    // The bug this guards: KV list() is eventually consistent and lagged
    // several seconds behind the write. A key stored fine, the UI re-read the
    // list, saw nothing, and looked like it had silently failed. The inventory
    // is tracked in an explicit index key read with get(), which has no such lag.
    await putProviderKey(withMaster, store(), 'immediate', KEY);
    const list = await listProviderKeys(withMaster, store());
    expect(list.immediate).toBeDefined();
    expect(await loadVaultKeys(withMaster, store())).toHaveProperty('immediate', KEY);
  });

  it('drops a provider from the listing as soon as it is deleted', async () => {
    await putProviderKey(withMaster, store(), 'gone', KEY);
    await deleteProviderKey(store(), 'gone');
    expect(await listProviderKeys(withMaster, store())).not.toHaveProperty('gone');
    expect(await loadVaultKeys(withMaster, store())).not.toHaveProperty('gone');
  });

  it('never lists the index key itself as a provider', async () => {
    await putProviderKey(withMaster, store(), 'real', KEY);
    const list = await listProviderKeys(withMaster, store());
    expect(Object.keys(list)).not.toContain('__index');
  });
});

describe('vault keys reach the capability routes, not just chat', () => {
  it('image generation authenticates with a key stored only in the vault', async () => {
    // The bug: a user added a Workers AI key through the chat app's provider
    // panel, chat worked, and image generation still said "skipped-no-key" —
    // capabilities.ts had its own providerKey() that read env only.
    const VAULT_KEY = 'cf-vault-only-key-abcdef0123456789';
    await env.CONFIG.put(
      'config',
      JSON.stringify({
        default_lane: 'AGENTIC',
        allow_paid: false,
        providers: {
          imgprov: {
            kind: 'openai',
            base_url: 'https://img.test/v1',
            // Deliberately an env var that is NOT bound in vitest.config.ts, so
            // the only way this request can authenticate is via the vault.
            key_env: 'DEFINITELY_UNSET_KEY',
            limits: { rpm: 30, rpd: 300 },
          },
        },
        lanes: { AGENTIC: ['imgprov/@cf/test/model'] },
        images: { chain: ['imgprov/@cf/test/model'] },
      }),
    );
    await putProviderKey(withMaster, store(), 'imgprov', VAULT_KEY);

    let seenAuth: string | null = null;
    fetchMock
      .get('https://img.test')
      .intercept({ path: '/run/@cf/test/model', method: 'POST' })
      .reply(200, (opts) => {
        const h = opts.headers as Record<string, string> | undefined;
        seenAuth = h?.authorization ?? h?.Authorization ?? null;
        return { result: { image: 'aGVsbG8=' }, success: true };
      });

    const res = await SELF.fetch('https://kompass.test/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-bearer-token' },
      body: JSON.stringify({ prompt: 'a lion' }),
    });

    // The mocked upstream body does not have to satisfy the image parser — the
    // property under test is that the request was ATTEMPTED, carrying a key
    // that exists ONLY in the vault, instead of being skipped as "no-key".
    void res;
    expect(seenAuth).toBe(`Bearer ${VAULT_KEY}`);
  });
});
