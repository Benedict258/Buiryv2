/**
 * Secret guard: refuses when a secret value from a local env file appears in a commit, a commit message, a report
 * or a transcript. It loads the values in memory to compare them and never prints, logs or writes any of them:
 * output is variable names and places only.
 *
 *   pnpm tsx scripts/secret-guard.ts --staged                 # pre-commit hook: added lines of the staged diff
 *   pnpm tsx scripts/secret-guard.ts --commit-msg <file>      # commit-msg hook: the message
 *   pnpm tsx scripts/secret-guard.ts [paths...]               # reports, transcripts (default: .buiry-local/reports
 *                                                             #   and .buiry-local/proof)
 *   --env <file> (repeatable) compares against that file instead of the local env files.
 *
 * Local env files: every `.env` or `.env.<name>` at the repository root except the committed examples. Exit 1 on a
 * leak, 0 when clean or when there is no local env file to compare against.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './lib/env-profile.js';
import { addedLinesByFile, findLeaksPerEnvFile, isLocalEnvFile, stagedEnvFiles } from './lib/secret-guard.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const envFiles: string[] = [];
for (let f = flag('--env'); f !== undefined; f = flag('--env')) envFiles.push(f);
const msgFile = flag('--commit-msg');
const staged = args.includes('--staged');
const paths = args.filter((a) => a !== '--staged');

// A staged local env file (.env, .env.testnet, .env.mainnet, ...) is refused outright, before anything else and even
// when there is no local env file to compare against (Phase 12 B6). Names only.
if (staged) {
  const envStaged = stagedEnvFiles(
    execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  );
  for (const f of envStaged)
    console.error(`[secret-guard] ${f} is a local env file and must never be committed`);
  if (envStaged.length) process.exit(1);
}
const files = envFiles.length
  ? envFiles
  : readdirSync(root)
      .filter(isLocalEnvFile)
      .map((f) => join(root, f));
if (!files.length) {
  console.log('[secret-guard] no local env file to compare against; nothing to check');
  process.exit(0);
}
// Phase 13 A: one entry per env file, never merged by name, so a shared name cannot hide either file's value.
const envs = files.map((f) => ({ file: basename(f), env: parseEnvText(readFileSync(f, 'utf8')) }));
const variableCount = envs.reduce((n, e) => n + Object.keys(e.env).length, 0);

const sources: { source: string; text: string }[] = [];
if (staged)
  sources.push(
    ...addedLinesByFile(
      execFileSync('git', ['diff', '--cached', '--no-color', '-U0'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      }),
    ),
  );
if (msgFile) sources.push({ source: 'commit message', text: readFileSync(msgFile, 'utf8') });
const walk = (p: string) => {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) if (e !== 'node_modules' && e !== '.git') walk(join(p, e));
    return;
  }
  if (st.size > 20 * 1024 * 1024) return;
  const buf = readFileSync(p);
  if (buf.includes(0)) return; // binary (screenshots): no text to leak into
  sources.push({ source: relative(root, p) || p, text: buf.toString('utf8') });
};
if (!staged && !msgFile)
  for (const p of paths.length ? paths : ['.buiry-local/reports', '.buiry-local/proof'])
    walk(resolve(root, p));
else for (const p of paths) walk(resolve(root, p));

const leaks = findLeaksPerEnvFile(envs, sources);
for (const l of leaks)
  console.error(`[secret-guard] the value of ${l.name} (from ${l.envFile}) appears in ${l.source}`);
console.log(
  `[secret-guard] ${leaks.length ? 'LEAK' : 'clean'}: compared ${variableCount} variables from ${files.length} env file(s), each on its own, with ${sources.length} source(s)`,
);
process.exit(leaks.length ? 1 : 0);
