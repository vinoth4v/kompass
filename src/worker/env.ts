import type { KompassState } from '../do/state';

export interface Env {
  KOMPASS_BEARER: string;
  OPENROUTER_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  GOOGLE_AI_KEY?: string;
  GROQ_API_KEY?: string;
  CONFIG: KVNamespace;
  KOMPASS_STATE: DurableObjectNamespace<KompassState>;
}
