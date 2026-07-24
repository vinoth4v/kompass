'use client';
import { useEffect, useRef, useState } from 'react';
import { Composer } from '@/components/Composer';
import { LoginScreen } from '@/components/LoginScreen';
import { MessageList } from '@/components/MessageList';
import { SettingsModal } from '@/components/SettingsModal';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import {
  KompassApiError,
  generateImage,
  sendMessage,
  verifyConnection,
  type AnthropicContentBlockWire,
  type AnthropicMessageWire,
} from '@/lib/kompassClient';
import { runResearch } from '@/lib/research';
import {
  clearAllData,
  loadConversations,
  loadSettings,
  newId,
  saveConversations,
  saveSettings,
} from '@/lib/storage';
import {
  DEFAULT_SETTINGS,
  type ChatMessage,
  type Conversation,
  type ConversationMode,
  type ImageAttachment,
  type KompassSettings,
  type LaneChoice,
} from '@/lib/types';

function deriveTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

function toWireMessages(messages: ChatMessage[]): AnthropicMessageWire[] {
  return messages.map((m) => {
    if (m.role === 'user' && m.images?.length) {
      const blocks: AnthropicContentBlockWire[] = m.images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      }));
      if (m.text) blocks.push({ type: 'text', text: m.text });
      return { role: 'user', content: blocks };
    }
    return { role: m.role, content: m.text };
  });
}

export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [settings, setSettingsState] = useState<KompassSettings | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionOk, setConnectionOk] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSettingsState(loadSettings());
    setConversations(loadConversations());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && settings) saveSettings(settings);
  }, [settings, mounted]);

  useEffect(() => {
    if (mounted) saveConversations(conversations);
  }, [conversations, mounted]);

  useEffect(() => {
    document.documentElement.classList.toggle('light', settings?.theme === 'light');
  }, [settings?.theme]);

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    const check = async () => {
      const r = await verifyConnection(settings.workerUrl, settings.bearer);
      if (!cancelled) setConnectionOk(r.ok);
    };
    check();
    const id = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        createConversation();
      }
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  if (!mounted) return null;

  if (!settings) {
    return (
      <LoginScreen
        onConnected={(workerUrl, bearer) =>
          setSettingsState({ ...DEFAULT_SETTINGS, workerUrl, bearer })
        }
      />
    );
  }

  const active = conversations.find((c) => c.id === activeId) ?? null;

  function updateConversation(id: string, updater: (c: Conversation) => Conversation) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...updater(c), updatedAt: Date.now() } : c)),
    );
  }

  function createConversation(mode: ConversationMode = 'chat') {
    const conv: Conversation = {
      id: newId(),
      title: '',
      mode,
      lane: settings?.defaultLane ?? 'kompass',
      systemPrompt: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setSidebarOpen(false);
  }

  function deleteConversation(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }

  function appendAssistant(conversationId: string, message: ChatMessage) {
    updateConversation(conversationId, (c) => ({ ...c, messages: [...c.messages, message] }));
  }

  async function runTurn(conversationId: string, mode: ConversationMode, lane: LaneChoice, messages: ChatMessage[]) {
    if (!settings) return;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    try {
      if (mode === 'image') {
        const result = await generateImage(settings, lastUser?.text ?? '', controller.signal);
        appendAssistant(conversationId, {
          id: newId(),
          role: 'assistant',
          text: '',
          generatedImage: { b64: result.b64, mime: result.mime },
          servedBy: result.model,
          createdAt: Date.now(),
        });
      } else if (mode === 'research') {
        const result = await runResearch(settings, lane, lastUser?.text ?? '', controller.signal);
        appendAssistant(conversationId, {
          id: newId(),
          role: 'assistant',
          text: result.text,
          sources: result.sources,
          servedBy: result.servedBy ?? undefined,
          lane: result.lane ?? undefined,
          usage: { input: result.usage.input, output: result.usage.output },
          createdAt: Date.now(),
        });
      } else {
        const { response, servedBy, lane: servedLane } = await sendMessage(
          settings,
          { model: lane, max_tokens: 4096, messages: toWireMessages(messages) },
          controller.signal,
        );
        const text = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n');
        appendAssistant(conversationId, {
          id: newId(),
          role: 'assistant',
          text: text || '(empty response)',
          servedBy: servedBy ?? undefined,
          lane: servedLane ?? undefined,
          usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
          createdAt: Date.now(),
        });
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      if (!aborted) {
        appendAssistant(conversationId, {
          id: newId(),
          role: 'assistant',
          text: e instanceof KompassApiError ? e.message : String(e),
          error: true,
          createdAt: Date.now(),
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleSend(text: string, images: ImageAttachment[]) {
    if (!active) return;
    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      text,
      images: images.length ? images : undefined,
      createdAt: Date.now(),
    };
    const withUser = [...active.messages, userMsg];
    updateConversation(active.id, (c) => ({
      ...c,
      messages: withUser,
      title: c.title || deriveTitle(text || 'Image attached'),
    }));
    void runTurn(active.id, active.mode, active.lane, withUser);
  }

  function handleRegenerate() {
    if (!active || busy) return;
    const trimmed = [...active.messages];
    if (trimmed[trimmed.length - 1]?.role === 'assistant') trimmed.pop();
    updateConversation(active.id, (c) => ({ ...c, messages: trimmed }));
    void runTurn(active.id, active.mode, active.lane, trimmed);
  }

  function handleEdit(messageId: string, text: string) {
    if (!active || busy) return;
    const idx = active.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const truncated = active.messages.slice(0, idx);
    const edited: ChatMessage = { ...active.messages[idx]!, text, createdAt: Date.now() };
    const next = [...truncated, edited];
    updateConversation(active.id, (c) => ({ ...c, messages: next }));
    void runTurn(active.id, active.mode, active.lane, next);
  }

  function handleDeleteMessage(id: string) {
    if (!active) return;
    updateConversation(active.id, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== id) }));
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-[#0a0d14] text-[#e8eaf0] light:bg-[#f9f9f7] light:text-[#0b0b0b]">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        onSelect={(id) => {
          setActiveId(id);
          setSidebarOpen(false);
        }}
        onNew={() => createConversation('chat')}
        onDelete={deleteConversation}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          conversation={active}
          connectionOk={connectionOk}
          theme={settings.theme}
          onToggleSidebar={() => setSidebarOpen(true)}
          onModeChange={(mode) => active && updateConversation(active.id, (c) => ({ ...c, mode }))}
          onLaneChange={(lane) => active && updateConversation(active.id, (c) => ({ ...c, lane }))}
          onToggleTheme={() =>
            setSettingsState((s) => (s ? { ...s, theme: s.theme === 'dark' ? 'light' : 'dark' } : s))
          }
        />

        {active ? (
          <>
            <MessageList
              messages={active.messages}
              mode={active.mode}
              busy={busy}
              onRegenerate={handleRegenerate}
              onEdit={handleEdit}
              onDelete={handleDeleteMessage}
              onExample={(text) => handleSend(text, [])}
            />
            <Composer mode={active.mode} busy={busy} onSend={handleSend} onStop={() => abortRef.current?.abort()} />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="text-sm text-white/40">No conversation selected.</p>
            <button
              onClick={() => createConversation('chat')}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-black/90 hover:bg-brand-400"
            >
              Start a new chat
            </button>
          </div>
        )}
      </div>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={setSettingsState}
          onClose={() => setSettingsOpen(false)}
          onLogout={() => {
            setSettingsState(null);
            setSettingsOpen(false);
          }}
          onClearData={() => {
            clearAllData();
            setSettingsState(null);
            setConversations([]);
            setActiveId(null);
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}
