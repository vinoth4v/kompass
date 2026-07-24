// `kompass models <list|disable|enable>` — a per-model on/off switch that
// doesn't touch which models are physically listed in lanes.yaml. Complements
// `kompass deprecate` (permanent, auto-replaced) with something reversible: a
// flaky model, a paused experiment, or "stop calling this while I investigate"
// without hunting down every lane it appears in. Edits lanes.yaml's
// `disabled_models` list via the yaml package's Document API (preserves
// existing comments), same pattern as deprecate.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, parseDocument } from 'yaml';
import { parseChainEntry } from '../worker/config';
import { compileConfig } from './compile-config';

interface LanesDocShape {
  lanes?: Record<string, unknown>;
  dispatcher?: { model?: string; fallbacks?: string[] };
  images?: { chain?: string[] };
  embeddings?: { chain?: string[] };
  disabled_models?: string[];
}

function allConfiguredEntries(parsed: LanesDocShape): string[] {
  const out = new Set<string>();
  for (const laneCfg of Object.values(parsed.lanes ?? {})) {
    const chain = Array.isArray(laneCfg) ? laneCfg : (laneCfg as { chain?: string[] })?.chain;
    for (const e of chain ?? []) out.add(e);
  }
  if (parsed.dispatcher?.model) out.add(parsed.dispatcher.model);
  for (const e of parsed.dispatcher?.fallbacks ?? []) out.add(e);
  for (const e of parsed.images?.chain ?? []) out.add(e);
  for (const e of parsed.embeddings?.chain ?? []) out.add(e);
  return [...out].sort();
}

export function listModels(configDir = 'config'): void {
  const parsed = parse(readFileSync(`${configDir}/lanes.yaml`, 'utf8')) as LanesDocShape;
  const disabled = new Set(parsed.disabled_models ?? []);
  const entries = allConfiguredEntries(parsed);
  console.log(`${entries.length} configured model entries (${disabled.size} disabled):\n`);
  for (const e of entries) {
    console.log(`  ${disabled.has(e) ? '✗ disabled' : '✓ enabled '}  ${e}`);
  }
  const orphaned = [...disabled].filter((e) => !entries.includes(e));
  if (orphaned.length) {
    console.log(`\ndisabled but not referenced by any lane/dispatcher/capability chain:`);
    for (const e of orphaned) console.log(`  ✗ disabled    ${e}`);
  }
}

function editDisabled(configDir: string, entry: string, add: boolean, action: string): void {
  try {
    parseChainEntry(entry);
  } catch (e) {
    console.error(`Invalid entry (expected "provider/model" shape): ${String(e)}`);
    process.exit(2);
  }
  const path = `${configDir}/lanes.yaml`;
  const original = readFileSync(path, 'utf8');
  const parsed = parse(original) as LanesDocShape;
  const current = parsed.disabled_models ?? [];
  const has = current.includes(entry);
  if (add && has) {
    console.log(`${entry} is already disabled.`);
    return;
  }
  if (!add && !has) {
    console.log(`${entry} is not currently disabled.`);
    return;
  }

  const doc = parseDocument(original);
  const next = add ? [...current, entry] : current.filter((e) => e !== entry);
  if (next.length) doc.setIn(['disabled_models'], next);
  else doc.deleteIn(['disabled_models']);
  writeFileSync(path, doc.toString());

  try {
    compileConfig(configDir); // validates; reverted below on failure
  } catch (e) {
    writeFileSync(path, original);
    console.error(`${action} would break config validation — reverted. ${String(e)}`);
    process.exit(1);
  }

  console.log(`${action}: ${entry}`);
  if (add) {
    console.log('  skipped everywhere it would otherwise be tried — chat lanes, images/');
    console.log('  embeddings chains, and the classifier — without removing it from lanes.yaml.');
  }
  console.log('\nRun `kompass config push` to apply.');
}

export function disableModel(entry: string | undefined, configDir = 'config'): void {
  if (!entry || entry.startsWith('--')) {
    console.error('Usage: kompass models disable <provider/model>');
    console.error('Example: kompass models disable openrouter/poolside/laguna-m.1:free');
    process.exit(2);
  }
  editDisabled(configDir, entry, true, 'Disabled');
}

export function enableModel(entry: string | undefined, configDir = 'config'): void {
  if (!entry || entry.startsWith('--')) {
    console.error('Usage: kompass models enable <provider/model>');
    process.exit(2);
  }
  editDisabled(configDir, entry, false, 'Enabled');
}
