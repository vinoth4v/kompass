// Runtime config: compiled from config/*.yaml by the CLI, stored in Workers KV,
// hot-reloaded via POST /config. Pure module — shared by Worker and CLI.

export interface ProviderLimits {
  rpm: number;
  rpd: number;
  /** Tokens-per-minute ceiling, when a provider enforces one separately from
   *  RPM/RPD (e.g. Groq's free tier). Optional — omitted means "not TPM-limited,
   *  or not verified" (M6 fit filter treats it as unbounded, never invented). */
  tpm?: number;
  /** Context window in tokens (input+output). Only meaningful per model_limits
   *  entry — a bare provider-wide `limits` block has no single ctx. Missing =
   *  unknown: the M6 fit filter keeps the entry but ranks it last, never
   *  hard-drops on absent data. */
  ctx?: number;
  /** Max output/completion tokens this model will accept in one request, when
   *  documented separately from (and smaller than) its context window. */
  max_out?: number;
}

export interface ProviderConfig {
  kind: 'openai' | 'gemini';
  base_url: string;
  key_env: string;
  enabled?: boolean;
  trains_on_data?: boolean;
  /** Models can read image/document (PDF) content blocks. Default false: text-only
   *  providers silently ignore such blocks, so requests carrying them skip ahead
   *  to a multimodal provider instead of answering blind. */
  multimodal?: boolean;
  /** Per-model multimodal capability for providers that are NOT wholly multimodal:
   *  these specific models can read image/document blocks even though the
   *  provider default is text-only (e.g. a vision model on an openai-kind host). */
  multimodal_models?: string[];
  limits: ProviderLimits;
  model_limits?: Record<string, ProviderLimits>;
  /** Fallback context window (M6) for a model_limits entry that declares none.
   *  Still optional/defaulted — an unmodified v1 config has no default_ctx
   *  anywhere and every entry stays "unknown ctx" (fit filter is inert). */
  default_ctx?: number;
  /** Model-listing endpoint for discovery; defaults to `${base_url}/models`. */
  discovery_url?: string;
}

export interface DispatcherConfig {
  model: string; // chain-entry form, e.g. "google/gemini-3.1-flash-lite"
  /** Backup classifier models tried in order when the primary fails/exhausts. */
  fallbacks?: string[];
  timeout_ms?: number;
  cache_ttl_s?: number;
  confidence_floor?: number;
}

export interface PrivacyConfig {
  block_patterns?: string[]; // regexes
  block_globs?: string[]; // path globs
}

export interface DeprecatedModelEntry {
  replaced_by: string; // chain-entry form, e.g. "openrouter/poolside/laguna-s-3.0:free"
  note?: string;
  since?: string; // YYYY-MM-DD
}

/**
 * M8 quality signal config (SPEC_V2 §5/§9). Corrective-turn detection is off
 * by default — SPEC_V2 §9 flags it as possibly too noisy to trust: "the user
 * pushed back" is inferred from a declared regex list against the newest
 * user turn, not a ground-truth signal.
 */
export interface QualityConfig {
  corrective_turn_detection?: boolean;
  corrective_patterns?: string[]; // regexes; required (non-empty) when detection is on
}

/**
 * A chain entry is plainly "provider/model", or an object carrying a human
 * override (M8, SPEC_V2 §5): `ban: true` excludes it from ever being
 * dispatched in this lane (beats a perfect adaptive score); `pin: <float>`
 * floors its score (beats a terrible one). Human judgment always wins over
 * the adaptive score — guardrail §6.15.
 */
export type ChainEntryConfig = string | { model: string; ban?: boolean; pin?: number };

export function chainEntryModel(entry: ChainEntryConfig): string {
  return typeof entry === 'string' ? entry : entry.model;
}

export function chainEntryBan(entry: ChainEntryConfig): boolean {
  return typeof entry === 'object' && entry.ban === true;
}

export function chainEntryPin(entry: ChainEntryConfig): number | undefined {
  return typeof entry === 'object' ? entry.pin : undefined;
}

/**
 * A lane's chain, plainly (old shape, spread_top defaults to 1 = strict priority
 * order, unchanged behavior) or with an explicit spread_top: the router picks
 * randomly among the top `spread_top` healthy candidates — weighted by each
 * entry's adaptive quality score — instead of always trying #1 first. This
 * spreads load across comparable models (avoiding one model's RPM ceiling
 * under bursty/parallel use) and lets outcomes adapt lane order without
 * touching YAML.
 */
export type LaneConfig = ChainEntryConfig[] | { chain: ChainEntryConfig[]; spread_top?: number };

export function laneChainConfigs(entry: LaneConfig | undefined): ChainEntryConfig[] {
  if (!entry) return [];
  return Array.isArray(entry) ? entry : entry.chain;
}

export function laneChainArray(entry: LaneConfig | undefined): string[] {
  return laneChainConfigs(entry).map(chainEntryModel);
}

export function laneSpreadTop(entry: LaneConfig | undefined, fallback = 1): number {
  if (!entry || Array.isArray(entry)) return fallback;
  return entry.spread_top ?? fallback;
}

/** Per-entry `pin`/`ban` overrides for a lane, keyed by plain "provider/model". */
export function laneOverrides(
  entry: LaneConfig | undefined,
): Record<string, { ban: boolean; pin?: number }> {
  const out: Record<string, { ban: boolean; pin?: number }> = {};
  for (const e of laneChainConfigs(entry)) {
    if (typeof e === 'object') out[e.model] = { ban: chainEntryBan(e), pin: e.pin };
  }
  return out;
}

/** Non-chat capability served by its own ordered fallback chain (images, embeddings). */
export interface CapabilityConfig {
  chain: string[];
}

export interface RouterConfig {
  version?: string;
  default_lane: string;
  allow_paid: boolean;
  providers: Record<string, ProviderConfig>;
  lanes: Record<string, LaneConfig>;
  dispatcher?: DispatcherConfig;
  privacy?: PrivacyConfig;
  /** M8 adaptive scoring config — see QualityConfig. Optional/defaulted: an
   *  unmodified pre-M8 config has none of this, and corrective-turn
   *  detection is off, matching the SPEC_V2 §9 default. */
  quality?: QualityConfig;
  /** Image generation chain for POST /v1/images/generations (optional capability). */
  images?: CapabilityConfig;
  /** Embeddings chain for POST /v1/embeddings (optional capability). */
  embeddings?: CapabilityConfig;
  /**
   * Declarative deprecation registry (compile-time only — see applyDeprecations).
   * Once an entry is listed here, it can never go live again even if it's still
   * physically present in a lane's chain in lanes.yaml: every config compile
   * transparently rewrites it to `replaced_by` before the config is pushed.
   */
  deprecated_models?: Record<string, DeprecatedModelEntry>;
  /**
   * Chain entries ("provider/model") temporarily switched off without removing
   * them from lanes.yaml — skipped wherever they'd otherwise be tried (chat
   * lanes, images/embeddings chains, the classifier). Unlike deprecated_models
   * this carries no replacement and is meant to be flipped back on any time
   * (a flaky model, a paused experiment). Manage with `kompass models
   * disable/enable <entry>`, which edits this list in place.
   */
  disabled_models?: string[];
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
    // M6: every fit-related field is optional, but if present must be sane —
    // never silently accept a zero/negative ctx/tpm/max_out (guardrail §6.16).
    if (p.default_ctx !== undefined && !(p.default_ctx > 0))
      throw new Error(`provider ${name}: default_ctx must be a positive number`);
    if (p.limits.tpm !== undefined && !(p.limits.tpm > 0))
      throw new Error(`provider ${name}: limits.tpm must be a positive number`);
    for (const [model, ml] of Object.entries(p.model_limits ?? {})) {
      for (const field of ['ctx', 'max_out', 'tpm'] as const) {
        const v = ml[field];
        if (v !== undefined && !(v > 0))
          throw new Error(
            `provider ${name} model_limits["${model}"]: ${field} must be a positive number`,
          );
      }
    }
  }

  if (c.dispatcher) {
    for (const entry of [c.dispatcher.model, ...(c.dispatcher.fallbacks ?? [])]) {
      const { provider } = parseChainEntry(entry);
      if (!c.providers[provider])
        throw new Error(`dispatcher entry "${entry}" references unknown provider`);
    }
  }

  if (c.deprecated_models) {
    for (const [oldEntry, info] of Object.entries(c.deprecated_models)) {
      parseChainEntry(oldEntry); // throws on malformed "provider/model" shape
      if (!info.replaced_by)
        throw new Error(`deprecated_models["${oldEntry}"]: replaced_by required`);
      const { provider, model } = parseChainEntry(info.replaced_by);
      if (!c.providers[provider])
        throw new Error(
          `deprecated_models["${oldEntry}"].replaced_by references unknown provider "${provider}"`,
        );
      if (!c.allow_paid && provider === 'openrouter' && !model.endsWith(':free'))
        throw new Error(
          `deprecated_models["${oldEntry}"].replaced_by "${info.replaced_by}" is not a :free model and allow_paid=false`,
        );
    }
  }

  if (c.disabled_models) {
    for (const entry of c.disabled_models) {
      const { provider } = parseChainEntry(entry); // throws on malformed "provider/model" shape
      if (!c.providers[provider])
        throw new Error(`disabled_models: unknown provider "${provider}" in "${entry}"`);
    }
  }

  for (const cap of ['images', 'embeddings'] as const) {
    const cc = c[cap];
    if (cc === undefined) continue;
    if (!Array.isArray(cc.chain) || cc.chain.length === 0)
      throw new Error(`${cap}.chain must be a non-empty array`);
    for (const entry of cc.chain) {
      const { provider } = parseChainEntry(entry);
      if (!c.providers[provider]) throw new Error(`${cap}: unknown provider "${provider}"`);
    }
  }

  for (const [lane, laneCfg] of Object.entries(c.lanes)) {
    const chainConfigs = laneChainConfigs(laneCfg);
    if (chainConfigs.length === 0) throw new Error(`lane ${lane}: empty chain`);
    if (!Array.isArray(laneCfg) && laneCfg.spread_top !== undefined) {
      if (!Number.isInteger(laneCfg.spread_top) || laneCfg.spread_top < 1)
        throw new Error(`lane ${lane}: spread_top must be a positive integer`);
    }
    for (const chainEntry of chainConfigs) {
      const entry = chainEntryModel(chainEntry);
      const { provider, model } = parseChainEntry(entry);
      if (!c.providers[provider]) throw new Error(`lane ${lane}: unknown provider "${provider}"`);
      // Guardrail §6.8: no paid model callable unless allow_paid. With a free-tier
      // OpenRouter key, only :free slugs are $0 — enforce in code, not convention.
      if (!c.allow_paid && provider === 'openrouter' && !model.endsWith(':free'))
        throw new Error(`lane ${lane}: ${entry} is not a :free model and allow_paid=false`);
      // M8: pin/ban are only meaningful on the object form.
      if (typeof chainEntry === 'object') {
        if (chainEntry.ban !== undefined && typeof chainEntry.ban !== 'boolean')
          throw new Error(`lane ${lane}: ${entry} ban must be a boolean`);
        if (
          chainEntry.pin !== undefined &&
          (typeof chainEntry.pin !== 'number' || chainEntry.pin < 0 || chainEntry.pin > 1)
        )
          throw new Error(`lane ${lane}: ${entry} pin must be a number in [0, 1]`);
      }
    }
  }

  if (c.quality?.corrective_turn_detection) {
    const patterns = c.quality.corrective_patterns ?? [];
    if (patterns.length === 0)
      throw new Error('quality.corrective_turn_detection is on but corrective_patterns is empty');
    for (const p of patterns) {
      try {
        new RegExp(p);
      } catch {
        throw new Error(`quality.corrective_patterns: invalid regex "${p}"`);
      }
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

/** True when `entry` ("provider/model") is in the disabled_models switch list. */
export function isModelDisabled(cfg: RouterConfig, entry: string): boolean {
  return cfg.disabled_models?.includes(entry) === true;
}

/**
 * Rewrite every deprecated entry in every lane's chain and the dispatcher's
 * model/fallbacks to its `replaced_by` target (follows chains of deprecations,
 * guarding against a cycle). Mutates `cfg` in place. Returns the unique set of
 * substitutions made, for the CLI to print. Called once at compile/push time
 * (see compile-config.ts) — the Worker only ever sees the already-substituted
 * config, so this never runs on the request path.
 */
export function applyDeprecations(cfg: RouterConfig): string[] {
  const dep = cfg.deprecated_models;
  if (!dep || Object.keys(dep).length === 0) return [];
  const substitutions = new Set<string>();

  const resolve = (entry: string): string => {
    let current = entry;
    const seen = new Set<string>();
    let info = dep[current];
    while (info && !seen.has(current)) {
      seen.add(current);
      const next = info.replaced_by;
      substitutions.add(`${current} → ${next}`);
      current = next;
      info = dep[current];
    }
    return current;
  };

  // M8: object-form entries carry pin/ban metadata that a plain resolve() over
  // laneChainArray's flattened strings would silently drop — resolve the model
  // id while preserving whatever wrapper shape (string vs {model,ban,pin}) it
  // already had.
  const resolveEntry = (e: ChainEntryConfig): ChainEntryConfig =>
    typeof e === 'string' ? resolve(e) : { ...e, model: resolve(e.model) };
  for (const [laneName, laneCfg] of Object.entries(cfg.lanes)) {
    const newChain = laneChainConfigs(laneCfg).map(resolveEntry);
    cfg.lanes[laneName] = Array.isArray(laneCfg) ? newChain : { ...laneCfg, chain: newChain };
  }
  if (cfg.dispatcher) {
    cfg.dispatcher.model = resolve(cfg.dispatcher.model);
    if (cfg.dispatcher.fallbacks) cfg.dispatcher.fallbacks = cfg.dispatcher.fallbacks.map(resolve);
  }
  return [...substitutions];
}

/** Resolve a lane name to its chain array, falling back to default_lane. */
export function resolveLaneChain(cfg: RouterConfig, lane: string): string[] {
  return laneChainArray(cfg.lanes[lane] ?? cfg.lanes[cfg.default_lane]);
}

export function resolveLaneSpreadTop(cfg: RouterConfig, lane: string): number {
  return laneSpreadTop(cfg.lanes[lane] ?? cfg.lanes[cfg.default_lane], 1);
}
