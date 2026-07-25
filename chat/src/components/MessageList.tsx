'use client';
import { Image as ImageIcon, MessageSquare, Telescope, Users } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatMessage, ConversationMode } from '@/lib/types';
import { MessageBubble } from './MessageBubble';

const EXAMPLES: Record<ConversationMode, string[]> = {
  chat: [
    'Explain how Kompass’s lane routing works',
    'Write a Python function to dedupe a list, preserving order',
    'What’s a good name for a compass-themed color palette?',
  ],
  image: [
    'A minimalist compass logo, flat design, blue gradient',
    'Cozy reading nook, warm light, watercolor style',
    'Isometric illustration of a cloud server rack',
  ],
  research: [
    'What are the latest developments in free-tier LLM APIs?',
    'Compare three open-weight coding models released this year',
    'Summarize best practices for LLM gateway rate limiting',
  ],
  // Council has its own surface (CouncilView) and never renders MessageList,
  // but the Record must stay exhaustive over ConversationMode.
  council: [],
};

const emptyIcon: Record<ConversationMode, typeof MessageSquare> = {
  chat: MessageSquare,
  image: ImageIcon,
  research: Telescope,
  // Unreachable — council renders CouncilView, not MessageList — but the map
  // must cover every mode for the lookup below to typecheck.
  council: Users,
};

export function MessageList({
  messages,
  mode,
  busy,
  onRegenerate,
  onEdit,
  onDelete,
  onExample,
}: {
  messages: ChatMessage[];
  mode: ConversationMode;
  busy: boolean;
  onRegenerate: () => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onExample: (text: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  if (messages.length === 0) {
    const Icon = emptyIcon[mode];
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Icon size={26} strokeWidth={1.75} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-medium tracking-tight text-ink">What can I help you with?</h2>
          <p className="text-sm text-ink-muted">Pick a starting point, or just start typing.</p>
        </div>
        <div className="flex max-w-xl flex-wrap justify-center gap-2">
          {EXAMPLES[mode].map((ex) => (
            <button
              key={ex}
              onClick={() => onExample(ex)}
              className="rounded-full border border-line bg-surface px-3.5 py-2 text-[0.8rem] text-ink-secondary transition duration-200 hover:border-line-strong hover:bg-surface-hover hover:text-ink"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const lastAssistantIdx = [...messages].reverse().findIndex((m) => m.role === 'assistant');
  const lastAssistantId =
    lastAssistantIdx >= 0 ? messages[messages.length - 1 - lastAssistantIdx]!.id : null;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-thread flex-col gap-7">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            isLast={m.id === lastAssistantId}
            onRegenerate={m.id === lastAssistantId ? onRegenerate : undefined}
            onEdit={m.role === 'user' ? (t) => onEdit(m.id, t) : undefined}
            onDelete={() => onDelete(m.id)}
          />
        ))}
        {busy && (
          <div className="kompass-thinking flex items-center text-ink-muted" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
