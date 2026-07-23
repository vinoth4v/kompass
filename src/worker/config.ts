// Runtime config: compiled from config/*.yaml by the CLI, stored in Workers KV,
// hot-reloaded via POST /config. Pure module — shared by Worker and CLI.

export interface ProviderLimits {
  rpm: number;
  rpd: number;
}

export interface ProviderConfig {
  kind: 'openai' | 'gemini';
  base_url: string;
  key_env: string;
  enabled?: boolean;
  trains_on_data?: boolean;
  limits: ProviderLimits;
  model_limits?: Record<string, ProviderLimits>;
}

export interface DispatcherConfig {
  model: string; // chain-entry form, e.g. "google/gemini-3.5-flash-lite"
  timeout_ms?: number;
  cache_ttl_s?: number;
  confidence_floor?: number;
}

export interface RouterConfig {
  version?: string;
  default_lane: string;
  allow_paid: boolean;
  providers: Record<string, ProviderConfig>;
  lanes: Record<string, string[]>;
  dispatcher?: DispatcherConfig;
}

export interface ChainEntry {
  provider: string;
  model: string;
}

/** "openrouter/poolside/laguna-s-2.1:free" → provider "openrouter", model "poolside/laguna-s-2.1:free" */
export function parseChainEntry(entry: string): ChainEntry {
  const i = entry.indexOf('/');
  if (i <= 0 || i === entry.length - 1) throw new Error(`invalid chain entry: ${entry}`);
  return { provider: entry.slice(0, i), model: entry.slice(i + 1) };
}

/** Throws with a descriptive message if the config is unusable. */
export function validateConfig(cfg: unknown): RouterConfig {
  const c = cfg as RouterConfig;
  if (!c || typeof c !== 'object') throw new Error('config must be an object');
  if (!c.providers || typeof c.providers !== 'object') throw new Error('config.providers missing');
  if (!c.lanes || typeof c.lanes !== 'object') throw new Error('config.lanes missing');
  if (typeof c.default_lane !== 'string' || !c.lanes[c.default_lane])
    throw new Error(`default_lane "${c.default_lane}" not present in lanes`);
  if (typeof c.allow_paid !== 'boolean') throw new Error('allow_paid must be boolean');

  for (const [name, p] of Object.entries(c.providers)) {
    if (p.kind !== 'openai' && p.kind !== 'gemini')
      throw new Error(`provider ${name}: unsupported kind "${p.kind}"`);
    if (!p.base_url?.startsWith('https://'))
      throw new Error(`provider ${name}: base_url must be https`);
    if (!p.key_env) throw new Error(`provider ${name}: key_env missing`);
    if (!p.limits || typeof p.limits.rpm !== 'number' || typeof p.limits.rpd !== 'number')
      throw new Error(`provider ${name}: limits.rpm/rpd required`);
  }

  if (c.dispatcher) {
    const { provider } = parseChainEntry(c.dispatcher.model);
    if (!c.providers[provider])
      throw new Error(`dispatcher.model references unknown provider "${provider}"`);
  }

  for (const [lane, chain] of Object.entries(c.lanes)) {
    if (!Array.isArray(chain) || chain.length === 0) throw new Error(`lane ${lane}: empty chain`);
    for (const entry of chain) {
      const { provider, model } = parseChainEntry(entry);
      if (!c.providers[provider]) throw new Error(`lane ${lane}: unknown provider "${provider}"`);
      // Guardrail §6.8: no paid model callable unless allow_paid. With a free-tier
      // OpenRouter key, only :free slugs are $0 — enforce in code, not convention.
      if (!c.allow_paid && provider === 'openrouter' && !model.endsWith(':free'))
        throw new Error(`lane ${lane}: ${entry} is not a :free model and allow_paid=false`);
    }
  }
  return c;
}

export const CONFIG_KV_KEY = 'config';

export async function loadConfig(kv: KVNamespace): Promise<RouterConfig | null> {
  const raw = await kv.get(CONFIG_KV_KEY, 'json');
  if (!raw) return null;
  try {
    return validateConfig(raw);
  } catch (e) {
    console.log(`stored config invalid: ${String(e)}`);
    return null;
  }
}

export function limitsFor(p: ProviderConfig, model: string): ProviderLimits {
  return p.model_limits?.[model] ?? p.limits;
}
