'use client';

// Provider key management, from the chat app, with nothing installed.
//
// Keys go browser → the user's OWN Worker → AES-GCM encrypted into their own
// KV (src/worker/vault.ts). They never touch this app's server: Vercel serves
// static assets only, and the request goes straight to the workers.dev origin.
//
// Nothing here ever displays a key. The list shows the masked form the Worker
// returns, and the input is cleared the moment a key is saved — so a key exists
// in the page for exactly as long as it takes to send it.
import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  deleteVaultKey,
  listProviders,
  listVaultKeys,
  putVaultKey,
  type ProviderInfo,
  type VaultStatus,
} from '@/lib/kompassClient';
import type { KompassSettings } from '@/lib/types';

/** Where to get a key, per provider. Signup URLs only — no key material. */
const SIGNUP: Record<string, { url: string; note: string }> = {
  openrouter: { url: 'https://openrouter.ai/keys', note: 'free tier, no card' },
  nvidia: { url: 'https://build.nvidia.com', note: 'free tier, no card' },
  google: { url: 'https://aistudio.google.com/apikey', note: 'free tier' },
  groq: { url: 'https://console.groq.com/keys', note: 'free tier, very fast' },
  mistral: { url: 'https://console.mistral.ai', note: 'free tier — trains on inputs' },
  github: { url: 'https://github.com/settings/personal-access-tokens', note: '"Models: read"' },
  sambanova: { url: 'https://cloud.sambanova.ai', note: 'free tier, no card' },
  cohere: { url: 'https://dashboard.cohere.com/api-keys', note: 'trial key' },
  hf: { url: 'https://huggingface.co/settings/tokens', note: 'Inference Providers permission' },
  cfai: { url: 'https://dash.cloudflare.com/profile/api-tokens', note: 'images + embeddings' },
};

export function ProvidersPanel({ settings }: { settings: KompassSettings }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [v, p] = await Promise.all([listVaultKeys(settings), listProviders(settings)]);
      setStatus(v);
      setProviders(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [settings]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(provider: string) {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      await putVaultKey(settings, provider, key);
      // Cleared immediately: the key should live in this page for no longer
      // than it takes to send it.
      setDraft('');
      setAdding(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: string) {
    setBusy(true);
    try {
      await deleteVaultKey(settings, provider);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-ink-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading your gateway…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ink">Model providers</h3>
        <p className="mt-1 text-[0.78rem] leading-relaxed text-ink-muted">
          Your gateway already answers using Cloudflare Workers AI on your own account, with no
          signup. Add providers below only when you want more capacity or stronger models.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[0.78rem] text-danger">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {status && !status.vault_enabled && (
        <div className="space-y-1.5 rounded-lg bg-warn-soft px-3 py-2.5 text-[0.78rem] text-warn">
          <p className="font-medium">
            Saving keys from this page is off: <span className="font-mono">KOMPASS_MASTER_KEY</span>{' '}
            is not set on your Worker.
          </p>
          <p className="leading-relaxed">
            You can still add providers — set each one directly as a Worker secret using the name
            shown below. In the Cloudflare dashboard: <b>Workers &amp; Pages</b> → your worker →{' '}
            <b>Settings</b> → <b>Variables and Secrets</b> → <b>Add</b> → type <b>Secret</b>. They
            take effect immediately, no redeploy.
          </p>
          <p className="leading-relaxed">
            To save keys from here instead, add a{' '}
            <span className="font-mono">KOMPASS_MASTER_KEY</span> secret the same way and reload.
          </p>
        </div>
      )}

      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {providers.map((p) => {
          const stored = status?.keys[p.name];
          const signup = SIGNUP[p.name];
          // The binding-backed provider authenticates as the account the Worker
          // runs on, so it has no key to configure. Showing it as "not
          // configured" was wrong — it is the one that already works.
          const keyless = p.kind === 'workers-ai';
          const configured = keyless || stored || p.hasEnvKey;
          return (
            <li key={p.name} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[0.82rem] text-ink">{p.name}</span>

                {configured ? (
                  <span className="flex items-center gap-1 text-[0.72rem] text-ok">
                    <Check className="h-3 w-3" />
                    {keyless
                      ? 'active — no key needed'
                      : p.hasEnvKey
                        ? 'set as Worker secret'
                        : stored!.masked}
                  </span>
                ) : (
                  <span className="text-[0.72rem] text-ink-faint">not configured</span>
                )}

                <span className="ml-auto flex items-center gap-2">
                  {p.keyEnv && !configured && !status?.vault_enabled && (
                    <button
                      onClick={() => void navigator.clipboard.writeText(p.keyEnv!)}
                      title="Copy the Worker secret name to set in the Cloudflare dashboard"
                      className="rounded-md border border-line px-2 py-0.5 font-mono text-[0.68rem] text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
                    >
                      {p.keyEnv}
                    </button>
                  )}
                  {signup && !configured && (
                    <a
                      href={signup.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-1 text-[0.72rem] text-accent hover:underline"
                    >
                      get a key <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {/* An env-var key is not ours to delete, and it wins over the
                      vault anyway — offering a delete button would imply
                      otherwise. */}
                  {stored && !p.hasEnvKey && (
                    <button
                      onClick={() => void remove(p.name)}
                      disabled={busy}
                      title={`Remove ${p.name} key`}
                      className="rounded-md p-1 text-ink-muted transition hover:bg-surface-hover hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {!p.hasEnvKey && status?.vault_enabled && (
                    <button
                      onClick={() => {
                        setAdding(adding === p.name ? null : p.name);
                        setDraft('');
                      }}
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-[0.72rem] text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
                    >
                      <Plus className="h-3 w-3" />
                      {stored ? 'replace' : 'add'}
                    </button>
                  )}
                </span>
              </div>

              {signup && !configured && (
                <p className="mt-0.5 text-[0.7rem] text-ink-faint">{signup.note}</p>
              )}
              {keyless && (
                <p className="mt-0.5 text-[0.7rem] text-ink-faint">
                  Cloudflare Workers AI, on your own account — this is what answers before you add
                  anything.
                </p>
              )}

              {adding === p.name && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void save(p.name);
                      if (e.key === 'Escape') setAdding(null);
                    }}
                    placeholder={`Paste your ${p.name} API key`}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[0.78rem] text-ink outline-none focus:border-line-strong"
                  />
                  <button
                    onClick={() => void save(p.name)}
                    disabled={busy || !draft.trim()}
                    className="rounded-lg bg-accent px-3 py-1.5 text-[0.78rem] font-medium text-accent-contrast transition hover:bg-accent-hover disabled:opacity-40"
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-[0.7rem] leading-relaxed text-ink-faint">
        Keys go straight from this page to your own Worker and are stored encrypted (AES-GCM) in
        your own Cloudflare KV. They never reach this app&rsquo;s server, and no screen here ever
        shows a key back to you.
      </p>
    </div>
  );
}
