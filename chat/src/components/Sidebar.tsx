'use client';
import { Check, Image as ImageIcon, MessageSquare, Plus, Search, Settings, Telescope, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Conversation } from '@/lib/types';

function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const modeIcon = { chat: MessageSquare, image: ImageIcon, research: Telescope };

export function Sidebar({
  conversations,
  activeId,
  open,
  onSelect,
  onNew,
  onDelete,
  onClose,
  onOpenSettings,
}: {
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const sorted = useMemo(
    () =>
      [...conversations]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((c) => c.title.toLowerCase().includes(query.toLowerCase())),
    [conversations, query],
  );

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-white/10 bg-[#0e1320] transition-transform lg:static lg:z-auto lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 p-3">
          <button
            onClick={onNew}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-brand-500 py-2 text-sm font-semibold text-black/90 transition hover:bg-brand-400"
          >
            <Plus size={16} /> New chat
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-white/50 hover:bg-white/10 lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5">
            <Search size={14} className="text-white/30" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              className="w-full bg-transparent text-sm outline-none placeholder:text-white/30"
            />
          </div>
        </div>

        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {sorted.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-white/30">
              {conversations.length === 0 ? 'No conversations yet.' : 'No matches.'}
            </p>
          )}
          {sorted.map((c) => {
            const Icon = modeIcon[c.mode];
            const active = c.id === activeId;
            const confirming = confirmingId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => (confirming ? undefined : onSelect(c.id))}
                onMouseLeave={() => confirming && setConfirmingId(null)}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${
                  active ? 'bg-white/10' : 'hover:bg-white/5'
                }`}
              >
                <Icon size={15} className="shrink-0 text-white/40" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{c.title || 'New conversation'}</div>
                  <div className="text-[0.72em] text-white/30">{relTime(c.updatedAt)}</div>
                </div>
                {confirming ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingId(null);
                      }}
                      title="Cancel"
                      className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
                    >
                      <X size={13} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                        setConfirmingId(null);
                      }}
                      title="Confirm delete"
                      className="rounded bg-red-500/20 p-1 text-red-400 hover:bg-red-500/30"
                    >
                      <Check size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(c.id);
                    }}
                    className="shrink-0 rounded p-1 text-white/0 transition hover:bg-white/10 hover:text-white/70 group-hover:text-white/40"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-white/10 p-2">
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-white/60 transition hover:bg-white/5 hover:text-white"
          >
            <Settings size={15} /> Settings
          </button>
        </div>
      </aside>
    </>
  );
}
