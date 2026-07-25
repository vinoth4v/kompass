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

describe('provider key vault', () => {
  it('round-trips a key through encryption', async () => {
    await putProviderKey(withMaster, 'openrouter', KEY);
    expect(await getProviderKey(withMaster, 'openrouter')).toBe(KEY);
  });

  it('never stores the key in plaintext', async () => {
    await putProviderKey(withMaster, 'nvidia', KEY);
    const raw = (await withMaster.CONFIG.get('vault:nvidia')) ?? '';
    expect(raw).not.toContain(KEY);
    // Not even a recognisable prefix should survive into the stored value.
    expect(raw).not.toContain('sk-or-v1-abcdefgh');
    const entry = JSON.parse(raw) as { ct: string; iv: string };
    expect(entry.ct.length).toBeGreaterThan(0);
    expect(entry.iv.length).toBeGreaterThan(0);
  });

  it('uses a fresh nonce per write — GCM nonce reuse leaks the keystream', async () => {
    await putProviderKey(withMaster, 'a', KEY);
    const first = JSON.parse((await withMaster.CONFIG.get('vault:a'))!) as {
      iv: string;
      ct: string;
    };
    await putProviderKey(withMaster, 'a', KEY);
    const second = JSON.parse((await withMaster.CONFIG.get('vault:a'))!) as {
      iv: string;
      ct: string;
    };
    expect(second.iv).not.toBe(first.iv);
    // Same plaintext, same key, different nonce => different ciphertext.
    expect(second.ct).not.toBe(first.ct);
  });

  it('reports a key as absent rather than throwing when it cannot decrypt', async () => {
    await putProviderKey(withMaster, 'groq', KEY);
    const rotated = { ...withMaster, KOMPASS_MASTER_KEY: 'a-different-master-key' } as typeof env;
    // A rotated master key must not take the gateway down — the key simply
    // looks unconfigured and the router routes elsewhere.
    expect(await getProviderKey(rotated, 'groq')).toBeNull();
  });

  it('is disabled, not broken, without a master key', async () => {
    expect(vaultAvailable(env)).toBe(false);
    expect(await getProviderKey(env, 'openrouter')).toBeNull();
    expect(await loadVaultKeys(env)).toEqual({});
  });

  it('listing exposes only masked values', async () => {
    await putProviderKey(withMaster, 'mistral', KEY);
    const list = await listProviderKeys(withMaster);
    expect(list.mistral!.masked).toBe('sk-or-v1…6789');
    expect(JSON.stringify(list)).not.toContain(KEY);
  });

  it('masks short keys without revealing most of them', () => {
    expect(maskKey('short')).toBe('sh…rt');
    expect(maskKey(KEY)).toBe('sk-or-v1…6789');
  });

  it('deletes', async () => {
    await putProviderKey(withMaster, 'cohere', KEY);
    await deleteProviderKey(withMaster, 'cohere');
    expect(await getProviderKey(withMaster, 'cohere')).toBeNull();
  });
});
