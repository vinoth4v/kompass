// Shared types for Kompass AI. Anthropic content-block shapes mirror the
// Worker's src/adapters/types.ts exactly — this app talks the native
// /v1/messages dialect directly.

export type LaneChoice =
  | 'kompass'
  | 'kompass-fast'
  | 'kompass-simple'
  | 'kompass-agentic'
  | 'kompass-hard'
  | 'kompass-longctx';

export const LANE_CHOICES: { value: LaneChoice; label: string; hint: string }[] = [
  { value: 'kompass', label: 'Auto', hint: 'classifier picks the lane by task complexity' },
  { value: 'kompass-fast', label: 'Fast', hint: 'small, instant — quick questions' },
  { value: 'kompass-simple', label: 'Simple', hint: 'everyday edits and answers' },
  { value: 'kompass-agentic', label: 'Agentic', hint: 'best free tool-calling models' },
  { value: 'kompass-hard', label: 'Hard', hint: 'max free reasoning' },
  { value: 'kompass-longctx', label: 'Long context', hint: '>60k-token contexts, 1M window' },
];

export interface ImageAttachment {
  mediaType: string;
  data: string; // base64, no data: prefix
  name: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Plain text content. Rendered as markdown for assistant messages. */
  text: string;
  images?: ImageAttachment[];
  /** Set on assistant messages produced by image-generation mode. */
  generatedImage?: { b64: string; mime: string };
  createdAt: number;
  servedBy?: string;
  lane?: string;
  usage?: { input: number; output: number };
  error?: boolean;
  /** Research mode: sources cited in this reply. */
  sources?: { title: string; url: string }[];
}

export type ConversationMode = 'chat' | 'image' | 'research';

export interface Conversation {
  id: string;
  title: string;
  mode: ConversationMode;
  lane: LaneChoice;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface KompassSettings {
  workerUrl: string;
  bearer: string;
  theme: 'dark' | 'light';
  defaultLane: LaneChoice;
}

export const DEFAULT_SETTINGS: Omit<KompassSettings, 'workerUrl' | 'bearer'> = {
  theme: 'dark',
  defaultLane: 'kompass',
};
