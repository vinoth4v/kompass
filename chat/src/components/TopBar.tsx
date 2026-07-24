'use client';
import {
  Image as ImageIcon,
  Menu,
  MessageSquare,
  Moon,
  Sun,
  Telescope,
} from 'lucide-react';
import { LANE_CHOICES, type Conversation, type ConversationMode, type LaneChoice } from '@/lib/types';

const modes: { value: ConversationMode; label: string; icon: typeof MessageSquare }[] = [
  { value: 'chat', label: 'Chat', icon: MessageSquare },
  { value: 'image', label: 'Image', icon: ImageIcon },
  { value: 'research', label: 'Research', icon: Telescope },
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
    <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
      <button
        onClick={onToggleSidebar}
        className="rounded-lg p-2 text-white/60 hover:bg-white/10 lg:hidden"
      >
        <Menu size={18} />
      </button>

      <div className="min-w-0 flex-1 truncate text-sm font-medium text-white/80">
        {conversation?.title || 'Kompass AI'}
      </div>

      {conversation && (
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-0.5">
          {modes.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => onModeChange(value)}
              title={label}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                conversation.mode === value
                  ? 'bg-brand-500 text-black/90'
                  : 'text-white/50 hover:text-white'
              }`}
            >
              <Icon size={13} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      )}

      {conversation && conversation.mode !== 'image' && (
        <select
          value={conversation.lane}
          onChange={(e) => onLaneChange(e.target.value as LaneChoice)}
          title="Routing lane"
          className="hidden rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs outline-none sm:block"
        >
          {LANE_CHOICES.map((l) => (
            <option key={l.value} value={l.value} className="bg-[#0e1320]">
              {l.label}
            </option>
          ))}
        </select>
      )}

      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          connectionOk === false ? 'bg-red-500' : connectionOk === null ? 'bg-white/20' : 'bg-emerald-400 kompass-pulse'
        }`}
        title={connectionOk === false ? 'Disconnected' : 'Connected'}
      />

      <button
        onClick={onToggleTheme}
        className="rounded-lg p-2 text-white/60 hover:bg-white/10"
        title="Toggle theme"
      >
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}
