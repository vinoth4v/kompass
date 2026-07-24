// All state lives in the browser's localStorage — no backend, no database.
// This mirrors the project's "$0 infra" ethos and the local `kompass ui`'s own
// per-machine persistence (~/.kompass/ui/), just scoped per-browser instead.
import type { Conversation, KompassSettings } from './types';

const SETTINGS_KEY = 'kompass_chat_settings_v1';
const CONVERSATIONS_KEY = 'kompass_chat_conversations_v1';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function loadSettings(): KompassSettings | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as KompassSettings;
  } catch {
    return null;
  }
}

export function saveSettings(settings: KompassSettings): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function clearSettings(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(SETTINGS_KEY);
}

export function loadConversations(): Conversation[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  } catch (e) {
    // Quota exceeded (localStorage ~5-10MB) — most likely from large base64
    // image attachments piling up across many conversations.
    console.error('Failed to persist conversations (storage quota?)', e);
  }
}

export function clearAllData(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(SETTINGS_KEY);
  window.localStorage.removeItem(CONVERSATIONS_KEY);
}

export function newId(): string {
  return crypto.randomUUID();
}
