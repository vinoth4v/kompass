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
import type { Env } from './env';

const KV_PREFIX = 'vault:';
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

export async function putProviderKey(env: Env, provider: string, key: string): Promise<VaultEntry> {
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
  await env.CONFIG.put(KV_PREFIX + provider, JSON.stringify(entry));
  return entry;
}

export async function getProviderKey(env: Env, provider: string): Promise<string | null> {
  if (!vaultAvailable(env)) return null;
  const raw = await env.CONFIG.get(KV_PREFIX + provider);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as VaultEntry;
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

export async function deleteProviderKey(env: Env, provider: string): Promise<void> {
  await env.CONFIG.delete(KV_PREFIX + provider);
}

/** Masked inventory for the UI — never returns key material. */
export async function listProviderKeys(
  env: Env,
): Promise<Record<string, { masked: string; ts: number }>> {
  const out: Record<string, { masked: string; ts: number }> = {};
  if (!vaultAvailable(env)) return out;
  const list = await env.CONFIG.list({ prefix: KV_PREFIX });
  for (const k of list.keys) {
    const raw = await env.CONFIG.get(k.name);
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw) as VaultEntry;
      out[k.name.slice(KV_PREFIX.length)] = { masked: entry.masked, ts: entry.ts };
    } catch {
      /* skip unreadable entries rather than failing the whole listing */
    }
  }
  return out;
}

/**
 * All vault keys for one request, as a plain map the router can consult
 * synchronously. Resolved once per request rather than per chain attempt: a
 * decrypt per attempt would put an AES operation on every hop of the fallback
 * ladder for no benefit.
 */
export async function loadVaultKeys(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!vaultAvailable(env)) return out;
  const list = await env.CONFIG.list({ prefix: KV_PREFIX });
  await Promise.all(
    list.keys.map(async (k) => {
      const provider = k.name.slice(KV_PREFIX.length);
      const key = await getProviderKey(env, provider);
      if (key) out[provider] = key;
    }),
  );
  return out;
}
