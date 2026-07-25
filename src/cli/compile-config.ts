// Node-side: compile config/*.yaml into the RouterConfig JSON stored in KV.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyDeprecations, validateConfig, type RouterConfig } from '../worker/config';

export function compileConfig(configDir = 'config'): RouterConfig {
  // voice.yaml is optional: a checkout without it compiles and runs with the
  // house voice simply off, rather than failing to build.
  let voiceDoc: { voice?: RouterConfig['voice'] } = {};
  try {
    voiceDoc = parse(readFileSync(join(configDir, 'voice.yaml'), 'utf8')) as typeof voiceDoc;
  } catch {
    /* no voice.yaml — feature disabled */
  }
  const providersDoc = parse(readFileSync(join(configDir, 'providers.yaml'), 'utf8')) as {
    providers: RouterConfig['providers'];
  };
  const lanesDoc = parse(readFileSync(join(configDir, 'lanes.yaml'), 'utf8')) as {
    default_lane: string;
    allow_paid: boolean;
    lanes: RouterConfig['lanes'];
    dispatcher?: RouterConfig['dispatcher'];
    compaction?: RouterConfig['compaction'];
    privacy?: RouterConfig['privacy'];
    deprecated_models?: RouterConfig['deprecated_models'];
    images?: RouterConfig['images'];
    embeddings?: RouterConfig['embeddings'];
    disabled_models?: RouterConfig['disabled_models'];
  };
  const cfg: RouterConfig = {
    version: new Date().toISOString(),
    providers: providersDoc.providers,
    default_lane: lanesDoc.default_lane,
    allow_paid: lanesDoc.allow_paid,
    lanes: lanesDoc.lanes,
    dispatcher: lanesDoc.dispatcher,
    compaction: lanesDoc.compaction,
    voice: voiceDoc.voice,
    privacy: lanesDoc.privacy,
    deprecated_models: lanesDoc.deprecated_models,
    images: lanesDoc.images,
    embeddings: lanesDoc.embeddings,
    disabled_models: lanesDoc.disabled_models,
  };
  const substitutions = applyDeprecations(cfg);
  for (const s of substitutions) console.log(`  deprecated: ${s}`);
  return validateConfig(cfg);
}
