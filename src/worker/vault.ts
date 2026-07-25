// Encrypted provider-key vault, stored in the user's OWN Cloudflare KV.
//
// WHOSE BACKEND. Keys are written to the KV namespace of the Worker the user
// deployed to their own Cloudflare account. There is deliberately no
// Kompass-operated store: a central database of other people's provider
// credentials would violate SPEC §3 ("no multi-tenant SaaS", "keys never shared
// with a third-party operator") and would be a standing honeypot — one breach
// leaking every user's OpenRouter, NVIDIA and Mistral keys at once. The whole
// point of Kompass is that the user's traffic and credentials stay on
// infrastructure they control.
//
// WHY ENCRYPT AT ALL, given the Worker can decrypt. Because "the Worker can read
// it" and "anything that can read the KV namespace can read it" are different
// threat models. KV values surface in the Cloudflare dashboard, in API reads
// with a KV-scoped token, and in exports. AES-GCM with a key derived from a
// deployment secret means a KV-scoped token is no longer enough to walk away
// with live provider keys. It does NOT protect against someone who already
// controls the Worker — nothing stored server-side could.
//
// WHY NOT WRANGLER SECRETS. They are the better primitive and remain supported,
// but `wrangler secret put` needs a local CLI install. This vault exists so a
// browser-only, non-technical user can add a provider key from the chat UI with
// nothing installed.
import type { KompassState } from '../do/state';
import type { Env } from './env';

/** Strongly consistent store — see the DO's vault section for why not KV. */
export type VaultStore = DurableObjectStub<KompassState>;

/**
 * Entries are stored in the DURABLE OBJECT, not KV.
 *
 * KV is eventually consistent: a key stored successfully did not appear in the
 * listing for tens of seconds, so the UI re-read after saving, saw nothing, and
 * looked like it had silently failed. An index key read with get() did not fix
 * it either — KV gives no read-after-write guarantee at all. Durable Object
 * storage is strongly consistent, so a stored key is visible immediately.
 */
/** Domain separation, so this key derivation can never collide with another. */
const HKDF_INFO = 'kompass-provider-key-vault-v1';

export interface VaultEntry {
  /** Base64 AES-GCM ciphertext. */
  ct: string;
  /** Base64 96-bit nonce — unique per write, never reused. */
  iv: string;
  /** When it was stored, for the UI. */
  ts: number;
  /** Masked form, safe to show and to log (never the key itself). */
  masked: string;
}

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * Show enough to recognise a key, never enough to use it: first 8 and last 4
 * characters. Everything that displays or logs a key goes through this.
 */
export function maskKey(key: string): string {
  if (key.length <= 14) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * AES-GCM key derived from KOMPASS_MASTER_KEY via HKDF. The master key is set
 * once at deploy time; deriving rather than using it directly means the same
 * secret can later back other encrypted values without key reuse.
 */
async function deriveKey(master: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(master),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Salt is empty by design: the master key is already high-entropy random,
      // which is the condition under which HKDF permits it.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function vaultAvailable(env: Env): boolean {
  return Boolean((env as unknown as Record<string, string | undefined>).KOMPASS_MASTER_KEY);
}

function masterKey(env: Env): string {
  const k = (env as unknown as Record<string, string | undefined>).KOMPASS_MASTER_KEY;
  if (!k) {
    throw new Error(
      'KOMPASS_MASTER_KEY is not set — the key vault is disabled. Set it as a Worker secret, ' +
        'or supply provider keys as environment secrets instead.',
    );
  }
  return k;
}

export async function putProviderKey(
  env: Env,
  store: VaultStore,
  provider: string,
  key: string,
): Promise<VaultEntry> {
  const aes = await deriveKey(masterKey(env));
  // A fresh 96-bit nonce per write. GCM nonce reuse under the same key is
  // catastrophic (it leaks the keystream), so this is never derived or stored
  // from anything reusable.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aes,
    new TextEncoder().encode(key),
  );
  const entry: VaultEntry = {
    ct: b64(ct),
    iv: b64(iv.buffer),
    ts: Date.now(),
    masked: maskKey(key),
  };
  await store.vaultPut(provider, entry);
  return entry;
}

export async function getProviderKey(
  env: Env,
  store: VaultStore,
  provider: string,
): Promise<string | null> {
  if (!vaultAvailable(env)) return null;
  const stored = await store.vaultGet(provider);
  if (!stored) return null;
  try {
    const entry = stored as VaultEntry;
    const aes = await deriveKey(masterKey(env));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(entry.iv) },
      aes,
      unb64(entry.ct),
    );
    return new TextDecoder().decode(pt);
  } catch (e) {
    // A rotated master key makes every existing entry undecryptable. Report it
    // as absent rather than throwing, so one bad entry cannot take the gateway
    // down — the key simply looks unconfigured and the router routes elsewhere.
    console.log(`vault: could not decrypt ${provider} (${String(e).slice(0, 80)})`);
    return null;
  }
}

export async function deleteProviderKey(store: VaultStore, provider: string): Promise<void> {
  await store.vaultDelete(provider);
}

/** Masked inventory for the UI — never returns key material. */
export async function listProviderKeys(
  env: Env,
  store: VaultStore,
): Promise<Record<string, { masked: string; ts: number }>> {
  const out: Record<string, { masked: string; ts: number }> = {};
  if (!vaultAvailable(env)) return out;
  for (const [provider, raw] of Object.entries(await store.vaultAll())) {
    const entry = raw as VaultEntry;
    if (entry?.masked) out[provider] = { masked: entry.masked, ts: entry.ts };
  }
  return out;
}

/**
 * All vault keys for one request, as a plain map the router can consult
 * synchronously. Resolved once per request rather than per chain attempt: a
 * decrypt per attempt would put an AES operation on every hop of the fallback
 * ladder for no benefit.
 */
export async function loadVaultKeys(env: Env, store: VaultStore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!vaultAvailable(env)) return out;
  // One DO round trip for every entry, then decrypt locally — cheaper than a
  // call per provider, and this runs once per request.
  const aes = await deriveKey(masterKey(env));
  for (const [provider, raw] of Object.entries(await store.vaultAll())) {
    const entry = raw as VaultEntry;
    if (!entry?.ct) continue;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(entry.iv) },
        aes,
        unb64(entry.ct),
      );
      out[provider] = new TextDecoder().decode(pt);
    } catch {
      /* rotated master key — treat as unconfigured, never throw */
    }
  }
  return out;
}
