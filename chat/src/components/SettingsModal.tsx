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
      <div className="w-full max-w-md rounded-2xl border border-line bg-[#0e1320] p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-hover"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">Worker URL</label>
            <input
              value={workerUrl}
              onChange={(e) => {
                setWorkerUrl(e.target.value);
                setTestResult('idle');
              }}
              className="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">
              Bearer token
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-black/30 px-3 py-2 focus-within:border-brand-500">
              <input
                type={showBearer ? 'text' : 'password'}
                value={bearer}
                onChange={(e) => {
                  setBearer(e.target.value);
                  setTestResult('idle');
                }}
                className="w-full bg-transparent text-sm outline-none"
              />
              <button onClick={() => setShowBearer((v) => !v)} className="shrink-0 text-ink-muted">
                {showBearer ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={test}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-hover"
            >
              Test connection
            </button>
            {testResult === 'testing' && <span className="text-xs text-ink-muted">Checking…</span>}
            {testResult === 'ok' && <span className="text-xs text-ok">✓ Connected</span>}
            {testResult === 'fail' && <span className="text-xs text-danger">{testError}</span>}
          </div>

          <button
            onClick={save}
            className="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-accent-contrast hover:bg-accent-hover"
          >
            Save
          </button>
        </div>

        <div className="mt-5 space-y-1 border-t border-line pt-4">
          <button
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-secondary hover:bg-surface"
          >
            <LogOut size={15} /> Log out
          </button>
          <button
            onClick={() => (confirmingClear ? onClearData() : setConfirmingClear(true))}
            onBlur={() => setConfirmingClear(false)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
              confirmingClear
                ? 'bg-danger-soft text-danger'
                : 'text-danger hover:bg-danger-soft hover:text-danger'
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
