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

/**
 * A file the user attached. Three kinds, because they reach the model by three
 * different routes:
 *   image    — an image block; needs a vision-capable model.
 *   document — a PDF as a base64 document block; Gemini reads these natively.
 *   text     — source, markdown, csv, json… read in the browser and sent as
 *              TEXT. This is the important one: it works with every model in
 *              the roster, vision or not, and most files people want to ask
 *              about are text.
 */
export interface Attachment {
  kind: 'image' | 'document' | 'text';
  mediaType: string;
  /** base64 payload for image/document; empty for text attachments. */
  data: string;
  /** Decoded contents for kind: 'text'. */
  text?: string;
  name: string;
  size?: number;
}

/** Legacy alias — the field on ChatMessage is still called `images`. */
export type ImageAttachment = Attachment;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Plain text content. Rendered as markdown for assistant messages. */
  text: string;
  images?: Attachment[];
  /** Set on assistant messages produced by image-generation mode. */
  generatedImage?: { b64: string; mime: string };
  createdAt: number;
  servedBy?: string;
  lane?: string;
  usage?: { input: number; output: number };
  error?: boolean;
  /** Research mode: sources cited in this reply. */
  sources?: { title: string; url: string }[];
  /** Suggested next questions, parsed out of the reply (see research.ts). */
  followups?: string[];
}

export type ConversationMode = 'chat' | 'image' | 'research' | 'council';

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
  theme: 'light',
  defaultLane: 'kompass',
};
