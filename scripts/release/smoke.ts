/**
 * Clean-install check for the packed tarballs (run scripts/release/pack.ts first). Installs the three tarballs into
 * a fresh directory outside the repository (so nothing resolves from the workspace), then:
 *   1. `buiry --help` and `buiry --version` from the installed CLI,
 *   2. `buiry doctor` with no configuration (must report, not crash),
 *   3. an MCP stdio handshake with the installed server: initialize, then tools/list must return 13 tools.
 * Needs the npm registry for third-party dependencies. Publishes nothing.
 *
 *   pnpm tsx scripts/release/smoke.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { OUT, ROOT, run } from './pack.js';

const release = JSON.parse(readFileSync(join(ROOT, 'release.json'), 'utf8')) as {
  version: string;
  packages: Record<'core' | 'mcp' | 'cli', string>;
};
const tgzs = readdirSync(OUT)
  .filter((f) => f.endsWith(`-${release.version}.tgz`))
  .map((f) => join(OUT, f));
if (tgzs.length !== 3) throw new Error(`expected 3 tarballs in ${OUT}; run scripts/release/pack.ts first`);

const dir = mkdtempSync(join(tmpdir(), 'buiry-smoke-'));
const home = join(dir, 'home');
const results: Record<string, unknown> = { dir };
try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', ...tgzs], dir);
  const nm = join(dir, 'node_modules');
  const cliBin = join(nm, ...release.packages.cli.split('/'), 'dist', 'bin.js');
  const mcpBin = join(nm, ...release.packages.mcp.split('/'), 'dist', 'bin.js');
  // A clean environment: no Buiry credentials, a private home so no stored config is read.
  const env = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
  };
  const node = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, args, {
      cwd: dir,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 60_000,
    });

  const help = node([cliBin, '--help']);
  results.help = { exit: help.status, firstLine: help.stdout.split('\n')[0] };
  const version = node([cliBin, '--version']);
  results.version = { exit: version.status, out: version.stdout.trim() };
  const doctor = node([cliBin, 'doctor']);
  results.doctor = {
    exit: doctor.status,
    crashed: /\n\s+at .+\(.+:\d+:\d+\)/.test(doctor.stderr),
    firstLines: (doctor.stdout + doctor.stderr).split('\n').slice(0, 4),
  };
  results.binsLinked = readdirSync(join(nm, '.bin')).filter((f) => /^buiry(-mcp)?(\.cmd)?$/.test(f));

  // MCP handshake through the SDK installed alongside the server (not the workspace copy).
  const req = createRequire(join(dir, 'package.json'));
  const sdk = (p: string) => import(pathToFileURL(req.resolve(`@modelcontextprotocol/sdk/${p}`)).href);
  const { Client } = await sdk('client/index.js');
  const { StdioClientTransport } = await sdk('client/stdio.js');
  const client = new Client({ name: 'buiry-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpBin],
    cwd: dir,
    env: { ...env, BUIRY_TOKEN: 'smoke-not-a-token', BUIRY_API_URL: 'http://127.0.0.1:9' },
    stderr: 'pipe',
  });
  await client.connect(transport);
  const tools = (await client.listTools()) as { tools: { name: string }[] };
  results.mcp = {
    server: client.getServerVersion(),
    toolCount: tools.tools.length,
    tools: tools.tools.map((t) => t.name).sort(),
  };
  await client.close();

  const ok =
    help.status === 0 &&
    version.stdout.trim() === release.version &&
    !(results.doctor as { crashed: boolean }).crashed &&
    tools.tools.length === 13;
  results.pass = ok;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
