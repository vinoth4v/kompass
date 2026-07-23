// Scheduled model-discovery (Cloudflare Cron Trigger, see wrangler.jsonc). Checks
// each provider's live /models roster, diffs it against what's actually wired into
// lanes.yaml/dispatcher and against yesterday's snapshot, and stores a report for
// /status + `kompass discovery` to surface. Deliberately detect-only: it NEVER
// writes lanes.yaml or pushes config — models added unverified this session looked
// fine in a roster listing but were broken in practice (dead endpoint, no tool
// support, cold/unresponsive); auto-promoting is how a working lane quietly breaks.
import type { DiscoveryReport, KompassState, ProviderDiscovery } from '../do/state';
import { laneChainArray, parseChainEntry, type ProviderConfig, type RouterConfig } from './config';
import type { Env } from './env';

const MAX_LISTED = 20;
const FETCH_TIMEOUT_MS = 15_000;

/** provider name → set of models already referenced by some lane or the dispatcher */
export function configuredModelsByProvider(cfg: RouterConfig): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  const add = (entry: string) => {
    try {
      const { provider, model } = parseChainEntry(entry);
      (out[provider] ??= new Set()).add(model);
    } catch {
      /* malformed entry — ignore, validateConfig already guards real configs */
    }
  };
  for (const laneCfg of Object.values(cfg.lanes)) for (const e of laneChainArray(laneCfg)) add(e);
  if (cfg.dispatcher) {
    add(cfg.dispatcher.model);
    for (const e of cfg.dispatcher.fallbacks ?? []) add(e);
  }
  return out;
}

/** Extract a flat list of model ids from a provider's /models response, whatever its shape. */
export function parseModelList(providerName: string, kind: string, json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const j = json as Record<string, unknown>;
  if (providerName === 'google' || kind === 'gemini') {
    const models = (j.models as Array<{ name?: string }> | undefined) ?? [];
    return models.map((m) => (m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  }
  if (providerName === 'github') {
    // GitHub Models catalog returns a bare array, not {data:[...]}.
    return Array.isArray(json)
      ? (json as Array<{ id?: string }>).map((m) => m.id ?? '').filter(Boolean)
      : [];
  }
  if (providerName === 'cfai') {
    const result = (j.result as Array<{ name?: string }> | undefined) ?? [];
    return result.map((m) => m.name ?? '').filter(Boolean);
  }
  // Default: OpenAI-style { data: [{ id }] }
  const data = (j.data as Array<{ id?: string }> | undefined) ?? [];
  return data.map((m) => m.id ?? '').filter(Boolean);
}

function discoveryHeaders(p: ProviderConfig, key: string): Record<string, string> {
  return p.kind === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
}

export async function runDiscovery(
  env: Env,
  cfg: RouterConfig,
  stub: DurableObjectStub<KompassState>,
): Promise<DiscoveryReport> {
  const configured = configuredModelsByProvider(cfg);
  const providers: Record<string, ProviderDiscovery> = {};

  for (const [name, p] of Object.entries(cfg.providers)) {
    if (p.enabled === false) continue;
    const key = (env as unknown as Record<string, string | undefined>)[p.key_env];
    if (!key) continue;

    const url = p.discovery_url ?? `${p.base_url}/models`;
    try {
      const res = await fetch(url, {
        headers: discoveryHeaders(p, key),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        providers[name] = {
          liveCount: 0,
          unconfigured: [],
          newSinceLast: [],
          error: `HTTP ${res.status}`,
        };
        continue;
      }
      const live = parseModelList(name, p.kind, await res.json());
      const prev = await stub.getRosterSnapshot(name);
      const configuredSet = configured[name] ?? new Set<string>();
      const newSinceLast = prev.length ? live.filter((m) => !prev.includes(m)) : [];
      const unconfigured = live.filter((m) => !configuredSet.has(m));
      providers[name] = {
        liveCount: live.length,
        unconfigured: unconfigured.slice(0, MAX_LISTED),
        newSinceLast: newSinceLast.slice(0, MAX_LISTED),
      };
      await stub.setRosterSnapshot(name, live);
    } catch (e) {
      providers[name] = {
        liveCount: 0,
        unconfigured: [],
        newSinceLast: [],
        error: String(e).slice(0, 150),
      };
    }
  }

  const report: DiscoveryReport = { ts: Date.now(), providers };
  await stub.recordDiscovery(report);
  console.log(
    `discovery: ${JSON.stringify(
      Object.fromEntries(
        Object.entries(providers).map(([k, v]) => [
          k,
          { new: v.newSinceLast.length, unconfigured: v.unconfigured.length, error: v.error },
        ]),
      ),
    )}`,
  );
  return report;
}
