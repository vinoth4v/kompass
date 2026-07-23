// Node-side: compile config/*.yaml into the RouterConfig JSON stored in KV.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyDeprecations, validateConfig, type RouterConfig } from '../worker/config';

export function compileConfig(configDir = 'config'): RouterConfig {
  const providersDoc = parse(readFileSync(join(configDir, 'providers.yaml'), 'utf8')) as {
    providers: RouterConfig['providers'];
  };
  const lanesDoc = parse(readFileSync(join(configDir, 'lanes.yaml'), 'utf8')) as {
    default_lane: string;
    allow_paid: boolean;
    lanes: RouterConfig['lanes'];
    dispatcher?: RouterConfig['dispatcher'];
    privacy?: RouterConfig['privacy'];
    deprecated_models?: RouterConfig['deprecated_models'];
  };
  const cfg: RouterConfig = {
    version: new Date().toISOString(),
    providers: providersDoc.providers,
    default_lane: lanesDoc.default_lane,
    allow_paid: lanesDoc.allow_paid,
    lanes: lanesDoc.lanes,
    dispatcher: lanesDoc.dispatcher,
    privacy: lanesDoc.privacy,
    deprecated_models: lanesDoc.deprecated_models,
  };
  const substitutions = applyDeprecations(cfg);
  for (const s of substitutions) console.log(`  deprecated: ${s}`);
  return validateConfig(cfg);
}
