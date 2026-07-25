'use client';
import { LogoMark } from './Logo';
import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { verifyConnection } from '@/lib/kompassClient';

export function LoginScreen({
  onConnected,
}: {
  onConnected: (workerUrl: string, bearer: string) => void;
}) {
  const [workerUrl, setWorkerUrl] = useState('');
  const [bearer, setBearer] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'error'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = workerUrl.trim().replace(/\/$/, '');
    const token = bearer.trim();
    if (!url || !token) return;
    setStatus('checking');
    setError('');
    const result = await verifyConnection(url, token);
    if (result.ok) {
      onConnected(url, token);
    } else {
      setStatus('error');
      setError(result.error);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0d14] px-4 text-[#e8eaf0]">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark size={44} className="text-ink" />
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">
              Kompass <span className="font-normal text-ink-muted">AI</span>
            </h1>
            <p className="mt-1 text-sm text-ink-muted">Sign in with your Kompass gateway</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="space-y-3 rounded-2xl border border-line bg-white/[0.03] p-5"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">Worker URL</label>
            <input
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="https://kompass.<you>.workers.dev"
              className="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">
              Bearer token
            </label>
            <input
              type="password"
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
              placeholder="KOMPASS_BEARER"
              className="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>

          {status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={status === 'checking' || !workerUrl.trim() || !bearer.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {status === 'checking' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <>
                Connect <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        <p className="mt-4 text-center text-xs leading-relaxed text-white/35">
          Your bearer is stored only in this browser and sent directly to your own Worker — never to
          a third party. Find both values in your{' '}
          <code className="rounded bg-surface-hover px-1 py-0.5">secrets/.secrets.json</code> or on
          your <code className="rounded bg-surface-hover px-1 py-0.5">status.html</code> dashboard.
        </p>
      </div>
    </div>
  );
}
