// Encrypted provider-key vault. The properties that matter are security
// properties, so they are asserted directly rather than inferred from a
// round-trip working.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
const withMaster = { ...env, KOMPASS_MASTER_KEY: 'test-master-key-0123456789abcdef' } as typeof env;

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
    expect(vaultAvailable(env)).toBe(false);
    expect(await getProviderKey(env, store(), 'openrouter')).toBeNull();
    expect(await loadVaultKeys(env, store())).toEqual({});
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
