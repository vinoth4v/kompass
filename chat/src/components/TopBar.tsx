'use client';
import {
  ChevronDown,
  Image as ImageIcon,
  Menu,
  MessageSquare,
  Moon,
  Sun,
  Telescope,
  Users,
} from 'lucide-react';
import { Wordmark } from './Logo';
import {
  LANE_CHOICES,
  type Conversation,
  type ConversationMode,
  type LaneChoice,
} from '@/lib/types';

const modes: { value: ConversationMode; label: string; icon: typeof MessageSquare }[] = [
  { value: 'chat', label: 'Chat', icon: MessageSquare },
  { value: 'image', label: 'Image', icon: ImageIcon },
  { value: 'research', label: 'Research', icon: Telescope },
  { value: 'council', label: 'Council', icon: Users },
];

export function TopBar({
  conversation,
  connectionOk,
  theme,
  onToggleSidebar,
  onModeChange,
  onLaneChange,
  onToggleTheme,
}: {
  conversation: Conversation | null;
  connectionOk: boolean | null;
  theme: 'dark' | 'light';
  onToggleSidebar: () => void;
  onModeChange: (mode: ConversationMode) => void;
  onLaneChange: (lane: LaneChoice) => void;
  onToggleTheme: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-bg/80 px-3 py-2.5 backdrop-blur-xl supports-[backdrop-filter]:bg-bg/60">
      <button
        onClick={onToggleSidebar}
        className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover lg:hidden"
      >
        <Menu size={18} />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Wordmark className="shrink-0" />
        {conversation?.title && (
          <>
            <span className="text-line-strong">/</span>
            <span className="min-w-0 truncate text-sm text-ink-secondary">
              {conversation.title}
            </span>
          </>
        )}
      </div>

      {conversation && (
        <div className="flex items-center gap-0.5 rounded-full border border-line bg-surface p-1">
          {modes.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => onModeChange(value)}
              title={label}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition duration-200 ${
                conversation.mode === value
                  ? 'bg-elevated text-ink shadow-sm ring-1 ring-line'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              <Icon size={13} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      )}

      {conversation && conversation.mode !== 'image' && (
        // A native select renders with the OS widget and is the loudest
        // unstyled element on the page. appearance-none plus an inline chevron
        // keeps it a real <select> (keyboard, mobile pickers, a11y all intact)
        // while matching the rest of the chrome.
        <div className="relative hidden sm:block">
          <select
            value={conversation.lane}
            onChange={(e) => onLaneChange(e.target.value as LaneChoice)}
            title="Routing lane"
            className="cursor-pointer appearance-none rounded-full border border-line bg-surface py-1.5 pl-3 pr-7 text-xs font-medium text-ink-secondary outline-none transition hover:border-line-strong hover:text-ink"
          >
            {LANE_CHOICES.map((l) => (
              <option key={l.value} value={l.value} className="bg-elevated text-ink">
                {l.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={13}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
          />
        </div>
      )}

      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          connectionOk === false
            ? 'bg-danger'
            : connectionOk === null
              ? 'bg-line-strong'
              : 'bg-ok kompass-pulse'
        }`}
        title={connectionOk === false ? 'Disconnected' : 'Connected'}
      />

      <button
        onClick={onToggleTheme}
        className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover"
        title="Toggle theme"
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}
