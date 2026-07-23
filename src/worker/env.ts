import type { KompassState } from '../do/state';

export interface Env {
  KOMPASS_BEARER: string;
  OPENROUTER_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  GOOGLE_AI_KEY?: string;
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  GITHUB_MODELS_KEY?: string;
  CF_WORKERS_AI_KEY?: string;
  SAMBANOVA_API_KEY?: string;
  COHERE_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  HF_API_KEY?: string;
  CONFIG: KVNamespace;
  KOMPASS_STATE: DurableObjectNamespace<KompassState>;
}
