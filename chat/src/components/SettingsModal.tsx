'use client';
import { Eye, EyeOff, LogOut, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { KompassSettings } from '@/lib/types';
import { verifyConnection } from '@/lib/kompassClient';

export function SettingsModal({
  settings,
  onSave,
  onClose,
  onLogout,
  onClearData,
}: {
  settings: KompassSettings;
  onSave: (s: KompassSettings) => void;
  onClose: () => void;
  onLogout: () => void;
  onClearData: () => void;
}) {
  const [workerUrl, setWorkerUrl] = useState(settings.workerUrl);
  const [bearer, setBearer] = useState(settings.bearer);
  const [showBearer, setShowBearer] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'ok' | 'fail' | 'testing'>('idle');
  const [testError, setTestError] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);

  const test = async () => {
    setTestResult('testing');
    const r = await verifyConnection(workerUrl.trim(), bearer.trim());
    if (r.ok) setTestResult('ok');
    else {
      setTestResult('fail');
      setTestError(r.error);
    }
  };

  const save = () => {
    onSave({ ...settings, workerUrl: workerUrl.trim().replace(/\/$/, ''), bearer: bearer.trim() });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0e1320] p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-white/50 hover:bg-white/10">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-white/60">Worker URL</label>
            <input
              value={workerUrl}
              onChange={(e) => {
                setWorkerUrl(e.target.value);
                setTestResult('idle');
              }}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-white/60">Bearer token</label>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 focus-within:border-brand-500">
              <input
                type={showBearer ? 'text' : 'password'}
                value={bearer}
                onChange={(e) => {
                  setBearer(e.target.value);
                  setTestResult('idle');
                }}
                className="w-full bg-transparent text-sm outline-none"
              />
              <button onClick={() => setShowBearer((v) => !v)} className="shrink-0 text-white/40">
                {showBearer ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={test}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10"
            >
              Test connection
            </button>
            {testResult === 'testing' && <span className="text-xs text-white/40">Checking…</span>}
            {testResult === 'ok' && <span className="text-xs text-emerald-400">✓ Connected</span>}
            {testResult === 'fail' && <span className="text-xs text-red-400">{testError}</span>}
          </div>

          <button
            onClick={save}
            className="w-full rounded-lg bg-brand-500 py-2 text-sm font-semibold text-black/90 hover:bg-brand-400"
          >
            Save
          </button>
        </div>

        <div className="mt-5 space-y-1 border-t border-white/10 pt-4">
          <button
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/60 hover:bg-white/5"
          >
            <LogOut size={15} /> Log out
          </button>
          <button
            onClick={() => (confirmingClear ? onClearData() : setConfirmingClear(true))}
            onBlur={() => setConfirmingClear(false)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
              confirmingClear
                ? 'bg-red-500/20 text-red-300'
                : 'text-red-400/80 hover:bg-red-500/10 hover:text-red-400'
            }`}
          >
            <Trash2 size={15} />
            {confirmingClear ? 'Click again to confirm — cannot be undone' : 'Clear all local data'}
          </button>
        </div>
      </div>
    </div>
  );
}
