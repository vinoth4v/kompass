// Cloudflare platform utilization for the status dashboard — how close Kompass
// ITSELF is to the Workers/KV/Durable Objects free-plan ceilings, distinct from
// the LLM provider quotas shown elsewhere in /status. Requires a Worker secret
// CLOUDFLARE_API_TOKEN with Account Analytics:Read scope — the same token
// already used for `wrangler deploy` has this scope (confirmed live 2026-07-23).
// Limits below verified live at developers.cloudflare.com/workers|kv|durable-objects
// /platform/limits/ on 2026-07-23; KV's "100k reads/1k writes/1GB" wording is
// ambiguous on per-namespace vs account-wide — TODO(verify) if it matters.
import type { Env } from './env';

const CACHE_TTL_MS = 60_000;
const GRAPHQL_TIMEOUT_MS = 8_000;

export interface CloudflareUsage {
  asOf: number;
  workers: {
    requests: number;
    cpuTimeMsTotal: number;
    cpuTimeMsP50: number;
    cpuTimeMsP99: number;
    errors: number;
    subrequests: number;
    requestsLimit: number;
    cpuMsPerRequestLimit: number;
  };
  durableObjects: { requests: number; errors: number; wallTimeMsTotal: number };
  kv: {
    reads: number;
    writes: number;
    storageBytes: number;
    readsLimit: number;
    writesLimit: number;
    storageLimit: number;
  };
}

let cache: { ts: number; data: CloudflareUsage } | null = null;

interface GraphQLAccountResponse {
  viewer: {
    accounts: Array<{
      workers: Array<{
        sum: { requests: number; cpuTimeUs: number; errors: number; subrequests: number };
        quantiles: { cpuTimeP50: number; cpuTimeP99: number };
      }>;
      durableObjects: Array<{ sum: { requests: number; errors: number; wallTime: number } }>;
      kvOps: Array<{ sum: { requests: number }; dimensions: { actionType: string } }>;
      kvStorage: Array<{ max: { byteCount: number } }>;
    }>;
  };
}

async function graphql(token: string, query: string): Promise<GraphQLAccountResponse> {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
  });
  const json = (await res.json()) as { data?: GraphQLAccountResponse; errors?: unknown };
  if (!res.ok || json.errors)
    throw new Error(JSON.stringify(json.errors ?? res.status).slice(0, 200));
  if (!json.data) throw new Error('empty GraphQL response');
  return json.data;
}

export async function getCloudflareUsage(env: Env): Promise<CloudflareUsage | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token || !env.CLOUDFLARE_ACCOUNT_ID) return null;

  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const now = `${new Date().toISOString().slice(0, 19)}Z`;
  const acc = env.CLOUDFLARE_ACCOUNT_ID;
  const kvNs = env.CLOUDFLARE_KV_NAMESPACE_ID;

  const query = `query {
    viewer {
      accounts(filter: {accountTag: "${acc}"}) {
        workers: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: "${today}"}) {
          sum { requests cpuTimeUs errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 }
        }
        durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {datetime_geq: "${today}"}) {
          sum { requests errors wallTime }
        }
        kvOps: kvOperationsAdaptiveGroups(limit: 10, filter: {datetime_geq: "${today}", namespaceId: "${kvNs}"}) {
          sum { requests }
          dimensions { actionType }
        }
        kvStorage: kvStorageAdaptiveGroups(limit: 1, filter: {namespaceId: "${kvNs}", datetime_geq: "${today}", datetime_leq: "${now}"}, orderBy: [datetime_DESC]) {
          max { byteCount }
          dimensions { datetime }
        }
      }
    }
  }`;

  try {
    const data = await graphql(token, query);
    const acct = data.viewer.accounts[0];
    if (!acct) return null;

    const w = acct.workers[0]?.sum ?? { requests: 0, cpuTimeUs: 0, errors: 0, subrequests: 0 };
    const wq = acct.workers[0]?.quantiles ?? { cpuTimeP50: 0, cpuTimeP99: 0 };
    const doSum = acct.durableObjects.reduce(
      (a, r) => ({
        requests: a.requests + r.sum.requests,
        errors: a.errors + r.sum.errors,
        wallTime: a.wallTime + r.sum.wallTime,
      }),
      { requests: 0, errors: 0, wallTime: 0 },
    );
    let reads = 0;
    let writes = 0;
    for (const row of acct.kvOps) {
      if (row.dimensions.actionType === 'read') reads += row.sum.requests;
      else if (row.dimensions.actionType === 'write') writes += row.sum.requests;
    }
    const storageBytes = acct.kvStorage[0]?.max.byteCount ?? 0;

    const usage: CloudflareUsage = {
      asOf: Date.now(),
      workers: {
        requests: w.requests,
        cpuTimeMsTotal: Math.round(w.cpuTimeUs / 1000),
        cpuTimeMsP50: Math.round(wq.cpuTimeP50 / 1000),
        cpuTimeMsP99: Math.round(wq.cpuTimeP99 / 1000),
        errors: w.errors,
        subrequests: w.subrequests,
        requestsLimit: 100_000,
        cpuMsPerRequestLimit: 10,
      },
      durableObjects: {
        requests: doSum.requests,
        errors: doSum.errors,
        wallTimeMsTotal: Math.round(doSum.wallTime / 1000),
      },
      kv: {
        reads,
        writes,
        storageBytes,
        readsLimit: 100_000,
        writesLimit: 1_000,
        storageLimit: 1_073_741_824, // 1 GB
      },
    };
    cache = { ts: Date.now(), data: usage };
    return usage;
  } catch (e) {
    console.log(`Cloudflare usage query failed: ${String(e).slice(0, 200)}`);
    return null;
  }
}
