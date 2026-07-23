// `kompass deprecate <old-entry> --replaced-by <new-entry> [--note] [--since]`
// The "proper way" to retire a model: a single declarative registry entry in
// lanes.yaml (deprecated_models) rather than manually hunting down and editing
// every lane that references it. compile-config.ts's applyDeprecations()
// rewrites every occurrence to the replacement at every future config push —
// so once deprecated, the old entry can never accidentally go live again, even
// if it's still physically listed in a lane's chain. This command edits
// lanes.yaml via the yaml package's Document API (preserves existing comments).
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, parseDocument } from 'yaml';
import { parseChainEntry } from '../worker/config';
import { compileConfig } from './compile-config';

export function deprecateModel(configDir = 'config'): void {
  const oldEntry = process.argv[3];
  const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const replacedBy = flag('replaced-by');
  const note = flag('note');
  const since = flag('since') ?? new Date().toISOString().slice(0, 10);

  if (!oldEntry || oldEntry.startsWith('--') || !replacedBy) {
    console.error(
      'Usage: kompass deprecate <old-entry> --replaced-by <new-entry> [--note "..."] [--since YYYY-MM-DD]',
    );
    console.error('Example: kompass deprecate openrouter/poolside/laguna-s-2.1:free \\');
    console.error('           --replaced-by openrouter/poolside/laguna-s-3.0:free \\');
    console.error('           --note "3.0 is faster with better coding benchmarks"');
    process.exit(2);
  }
  try {
    parseChainEntry(oldEntry);
    parseChainEntry(replacedBy);
  } catch (e) {
    console.error(`Invalid entry (expected "provider/model" shape): ${String(e)}`);
    process.exit(2);
  }

  const path = `${configDir}/lanes.yaml`;
  const original = readFileSync(path, 'utf8');

  // Report where the old entry currently lives — those lines need no manual
  // edit, applyDeprecations() substitutes them transparently at every push.
  const parsed = parse(original) as {
    lanes?: Record<string, unknown>;
    dispatcher?: { model?: string; fallbacks?: string[] };
  };
  const occurrences: string[] = [];
  for (const [lane, laneCfg] of Object.entries(parsed.lanes ?? {})) {
    const chain = Array.isArray(laneCfg) ? laneCfg : (laneCfg as { chain?: string[] })?.chain;
    if (chain?.includes(oldEntry)) occurrences.push(lane);
  }
  if (parsed.dispatcher?.model === oldEntry || parsed.dispatcher?.fallbacks?.includes(oldEntry)) {
    occurrences.push('dispatcher');
  }

  const doc = parseDocument(original);
  const info: Record<string, string> = { replaced_by: replacedBy, since };
  if (note) info.note = note;
  doc.setIn(['deprecated_models', oldEntry], info);
  writeFileSync(path, doc.toString());

  try {
    compileConfig(configDir); // validates + previews the substitution; reverted below on failure
  } catch (e) {
    writeFileSync(path, original);
    console.error(`Deprecation would break config validation — reverted. ${String(e)}`);
    process.exit(1);
  }

  console.log(`\nDeprecated: ${oldEntry} → ${replacedBy}`);
  if (occurrences.length) {
    console.log(`  currently referenced in: ${occurrences.join(', ')}`);
    console.log('  no manual edits needed there — substituted automatically at every config push.');
  } else {
    console.log('  not currently referenced in any lane — recorded in the registry regardless.');
  }
  console.log('\nRun `kompass config push` to apply.');
}
