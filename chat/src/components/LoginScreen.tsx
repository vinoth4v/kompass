'use client';
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
          <svg viewBox="0 0 64 64" className="h-12 w-12">
            <defs>
              <linearGradient id="kg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#38bdf8" />
                <stop offset="1" stopColor="#6366f1" />
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="30" fill="url(#kg)" />
            <circle cx="32" cy="32" r="24" fill="#0f172a" />
            <g stroke="#7dd3fc" strokeWidth="2.5" strokeLinecap="round">
              <line x1="32" y1="11" x2="32" y2="15" transform="rotate(45 32 32)" />
              <line x1="32" y1="11" x2="32" y2="15" transform="rotate(135 32 32)" />
              <line x1="32" y1="11" x2="32" y2="15" transform="rotate(225 32 32)" />
              <line x1="32" y1="11" x2="32" y2="15" transform="rotate(315 32 32)" />
            </g>
            <polygon points="32,12 39,32 25,32" fill="#f43f5e" />
            <polygon points="32,52 25,32 39,32" fill="#e2e8f0" />
            <circle cx="32" cy="32" r="3.5" fill="#0f172a" stroke="#e2e8f0" strokeWidth="1.5" />
          </svg>
          <div>
            <h1 className="text-lg font-bold">
              Kom<span className="text-amber-400">pass</span> AI
            </h1>
            <p className="mt-1 text-sm text-white/50">Sign in with your Kompass gateway</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-white/60">Worker URL</label>
            <input
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="https://kompass.<you>.workers.dev"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-white/60">Bearer token</label>
            <input
              type="password"
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
              placeholder="KOMPASS_BEARER"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>

          {status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={status === 'checking' || !workerUrl.trim() || !bearer.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 py-2.5 text-sm font-semibold text-black/90 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-40"
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
          Your bearer is stored only in this browser and sent directly to your own Worker — never
          to a third party. Find both values in your{' '}
          <code className="rounded bg-white/10 px-1 py-0.5">secrets/.secrets.json</code> or on your{' '}
          <code className="rounded bg-white/10 px-1 py-0.5">status.html</code> dashboard.
        </p>
      </div>
    </div>
  );
}
