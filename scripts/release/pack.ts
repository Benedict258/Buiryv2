/**
 * Builds publishable tarballs for the Apache-2.0 packages (core, mcp, cli) without touching the workspace manifests.
 * Names and the version come from one setting, release.json. Each package is staged under .buiry-local/release/stage
 * with a manifest that points at dist, declares exactly the runtime dependencies its bundle imports (checked, not
 * guessed), and is packed with `npm pack`. Nothing is published.
 *
 *   pnpm tsx scripts/release/pack.ts            # build, stage, pack
 *   pnpm tsx scripts/release/pack.ts --dry-run  # also run `npm publish --dry-run` in each staged package
 */
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const OUT = join(ROOT, '.buiry-local', 'release');
const release = JSON.parse(readFileSync(join(ROOT, 'release.json'), 'utf8')) as {
  version: string;
  packages: Record<'core' | 'mcp' | 'cli', string>;
};
type Key = keyof typeof release.packages;

const DESCRIPTIONS: Record<Key, string> = {
  core: 'Buiry core: memory model, namespaces, briefing and redaction (pure, no I/O).',
  mcp: 'Buiry MCP server: shared, verifiable project memory for AI coding agents.',
  cli: 'Buiry CLI: connect coding agents to shared, verifiable project memory.',
};
const BINS: Partial<Record<Key, Record<string, string>>> = {
  mcp: { 'buiry-mcp': './dist/bin.js' },
  cli: { buiry: './dist/bin.js' },
};
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Runs a command; returns stdout and stderr together (npm reports on stderr) and throws on a non-zero exit. */
export function run(cmd: string, args: string[], cwd = ROOT): string {
  // npm and corepack are .cmd shims on Windows, which need a shell; quote arguments with spaces for it.
  const win = process.platform === 'win32';
  const a = win ? args.map((x) => (/[\s']/.test(x) ? `"${x}"` : x)) : args;
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8', shell: win });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${out.slice(-2000)}`);
  return out;
}

/** Bare package names imported by the built JS and declarations. */
function importsOf(dist: string): { js: Set<string>; dts: Set<string> } {
  const js = new Set<string>();
  const dts = new Set<string>();
  for (const f of readdirSync(dist)) {
    if (!/\.(js|d\.ts)$/.test(f)) continue;
    const src = readFileSync(join(dist, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"./][^'"]*)['"]/g)) {
      const spec = m[1]!;
      // Only real package specifiers (bundles also contain strings that merely look like imports).
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w./-]+)?$/i.test(spec)) continue;
      if (builtins.has(spec) || builtins.has(spec.split('/')[0]!)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      (f.endsWith('.d.ts') ? dts : js).add(name);
    }
  }
  return { js, dts };
}

export function stage(key: Key): string {
  const pkgDir = join(ROOT, 'packages', key);
  const ws = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    name: string;
    dependencies?: Record<string, string>;
  };
  const dist = join(pkgDir, 'dist');
  if (!existsSync(join(dist, 'index.js'))) throw new Error(`${key}: dist/index.js missing (build first)`);
  const { js, dts } = importsOf(dist);
  const deps: Record<string, string> = {};
  const workspaceNames = new Map(
    (Object.keys(release.packages) as Key[]).map((k) => [`@buiry/${k}`, release.packages[k]]),
  );
  for (const name of new Set([...js, ...dts])) {
    if (workspaceNames.has(name)) {
      // Bundled into the JS; the declarations still refer to it, so depend on the published package.
      if (js.has(name)) throw new Error(`${key}: bundle imports workspace package ${name} at runtime`);
      deps[workspaceNames.get(name)!] = release.version;
      continue;
    }
    const range = ws.dependencies?.[name];
    if (!range) throw new Error(`${key}: the build imports ${name}, which is not in its dependencies`);
    deps[name] = range;
  }
  const dir = join(OUT, 'stage', key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(dist, join(dir, 'dist'), { recursive: true });
  for (const f of ['LICENSE', 'README.md']) {
    if (!existsSync(join(pkgDir, f))) throw new Error(`${key}: ${f} missing`);
    cpSync(join(pkgDir, f), join(dir, f));
  }
  const manifest = {
    name: release.packages[key],
    version: release.version,
    description: DESCRIPTIONS[key],
    license: 'Apache-2.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    ...(BINS[key] ? { bin: BINS[key] } : {}),
    files: ['dist', 'LICENSE', 'README.md'],
    engines: { node: '>=20' },
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dry = process.argv.includes('--dry-run');
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.tgz')) rmSync(join(OUT, f));
  for (const key of Object.keys(release.packages) as Key[]) {
    run('corepack', ['pnpm', '--filter', `@buiry/${key}`, 'run', 'build']);
    const dir = stage(key);
    run('npm', ['pack', '--pack-destination', OUT], dir);
    const stem = release.packages[key].replace(/^@/, '').replace('/', '-');
    const tgz = readdirSync(OUT).find((f) => f === `${stem}-${release.version}.tgz`);
    if (!tgz) throw new Error(`${key}: npm pack produced no ${stem}-${release.version}.tgz`);
    console.log(`${release.packages[key]}@${release.version}: ${join(OUT, tgz)}`);
    if (dry) {
      const out = run('npm', ['publish', '--dry-run', '--access', 'public'], dir);
      console.log(
        out
          .split('\n')
          .filter((l) => /Tarball Contents|total files|package size|name:|version:/i.test(l))
          .join('\n'),
      );
    }
  }
}
