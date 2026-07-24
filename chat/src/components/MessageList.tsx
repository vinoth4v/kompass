'use client';
import { Image as ImageIcon, MessageSquare, Telescope } from 'lucide-react';
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
};

const emptyIcon = { chat: MessageSquare, image: ImageIcon, research: Telescope };

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
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="rounded-2xl bg-white/5 p-4">
          <Icon size={28} className="text-white/30" />
        </div>
        <p className="text-sm text-white/40">Try one of these, or write your own:</p>
        <div className="flex max-w-lg flex-wrap justify-center gap-2">
          {EXAMPLES[mode].map((ex) => (
            <button
              key={ex}
              onClick={() => onExample(ex)}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
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
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-6">
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
        <div className="flex items-center gap-1.5 px-1 text-white/30">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/40 [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/40 [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/40" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
