// Location logic for the CLI, so `kompass` works both ways it can be obtained:
//
//   - cloned repo  — `pnpm kompass <cmd>` from the repo root (the original, and
//     still the path the docs lead with for contributors). cwd IS the package.
//   - npm install  — `npx kompass-gateway <cmd>` / a global install, run from
//     any directory. cwd is the USER's project and holds only their config and
//     secrets; the worker source, defaults and node_modules live in the
//     installed package, somewhere entirely different.
//
// The split that makes both work: cwd owns user data (secrets/, config/,
// wrangler.jsonc), the package owns code (src/worker, node_modules). A
// scaffolded wrangler.jsonc points `main` at the package's worker by absolute
// path, so esbuild resolves `hono` from the package's own node_modules while
// the user's KV id and account settings stay in their directory.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Root of the installed package / cloned repo (this file is at <root>/src/cli/). */
export function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/** True when the process is running inside the package itself (the clone case). */
export function inPackageDir(): boolean {
  return resolve(process.cwd()) === resolve(packageRoot());
}

/**
 * Absolute path to wrangler's CLI entry. wrangler is a real dependency (not a
 * devDependency) precisely so this resolves for an installed user too — but
 * `exports` maps can block deep resolution, so fall back to the bin shim and
 * finally to a bare `wrangler` on PATH.
 */
function wranglerEntry(): { cmd: string; prefixArgs: string[] } {
  const req = createRequire(join(packageRoot(), 'package.json'));
  try {
    return { cmd: process.execPath, prefixArgs: [req.resolve('wrangler/bin/wrangler.js')] };
  } catch {
    /* exports-restricted — try the bin shim below */
  }
  const shim = join(packageRoot(), 'node_modules', '.bin', 'wrangler');
  if (existsSync(shim)) return { cmd: shim, prefixArgs: [] };
  return { cmd: 'wrangler', prefixArgs: [] };
}

/**
 * Run wrangler against the USER's config. Replaces the old `pnpm exec wrangler`
 * shell-outs, which assumed pnpm plus a local node_modules and so could never
 * work from an installed package.
 */
export function runWrangler(args: string[], opts: SpawnSyncOptions = {}): number {
  const { cmd, prefixArgs } = wranglerEntry();
  // --config is what lets wrangler build the packaged worker while reading the
  // user's settings; in the clone case it names the repo's own file, i.e. a no-op.
  const configArgs = ['--config', wranglerConfigPath()];
  const res = spawnSync(cmd, [...prefixArgs, ...args, ...configArgs], {
    stdio: 'inherit',
    ...opts,
  });
  if (res.error) {
    console.error(`  \x1b[31m✗\x1b[0m could not run wrangler: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

/** Same, but fails the process on a non-zero exit (the old execSync behaviour). */
export function runWranglerOrDie(args: string[], opts: SpawnSyncOptions = {}): void {
  const status = runWrangler(args, opts);
  if (status !== 0) process.exit(status);
}

export function wranglerConfigPath(): string {
  return join(process.cwd(), 'wrangler.jsonc');
}

/** Absolute path to the CLI's own entry — for re-spawning itself. A relative
 *  'src/cli/index.ts' only resolves when cwd happens to be the package. */
export function cliEntry(): string {
  return join(packageRoot(), 'src', 'cli', 'index.ts');
}

/**
 * Absolute file: URL of the tsx loader, for re-spawning node on TypeScript.
 * A bare `--import tsx` resolves against CWD — the user's directory for an
 * installed package, where tsx does not exist. See bin/kompass.mjs.
 */
export function tsxLoader(): string {
  const req = createRequire(join(packageRoot(), 'package.json'));
  return pathToFileURL(req.resolve('tsx')).href;
}

/** Packaged smoke-test entry — `pnpm smoke` only exists inside the repo. */
export function smokeEntry(): string {
  return join(packageRoot(), 'scripts', 'smoke.ts');
}

/**
 * How the user invokes this CLI, for printed hints: inside a clone it is
 * `pnpm kompass`, installed it is plain `kompass`. Printing the wrong one sends
 * people to a command that does not exist on their machine.
 */
export function cliInvocation(): string {
  return inPackageDir() ? 'pnpm kompass' : 'kompass';
}

/**
 * Make the current directory a Kompass project if it isn't one already: a
 * wrangler.jsonc pointing at the packaged worker, plus editable copies of the
 * default lane/provider config. Never overwrites anything that exists, so it is
 * safe on re-run and a complete no-op inside a cloned repo.
 *
 * Returns the list of files created, for the caller to report.
 */
export function ensureProject(): string[] {
  const created: string[] = [];
  const root = packageRoot();
  if (inPackageDir()) return created;

  // config/*.yaml — the product's main knob; users are expected to edit these.
  if (!existsSync(join(process.cwd(), 'config'))) {
    cpSync(join(root, 'config'), join(process.cwd(), 'config'), { recursive: true });
    created.push('config/lanes.yaml', 'config/providers.yaml');
  }

  const target = wranglerConfigPath();
  if (!existsSync(target)) {
    // Point `main` at the packaged worker by absolute path. Module resolution
    // follows the importing FILE, so the worker's `hono` import resolves inside
    // the package even though wrangler is invoked from the user's directory.
    const packagedMain = join(root, 'src', 'worker', 'index.ts');
    const src = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const patched = src.replace(
      /("main":\s*")([^"]+)(")/,
      (_m, a: string, main: string, b: string) =>
        a + (isAbsolute(main) ? main : packagedMain).replace(/\\/g, '\\\\') + b,
    );
    mkdirSync(process.cwd(), { recursive: true });
    writeFileSync(target, patched);
    created.push('wrangler.jsonc');
  }
  return created;
}
