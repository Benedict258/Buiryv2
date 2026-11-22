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
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './lib/env-profile.js';
import { addedLinesByFile, findLeaks } from './lib/secret-guard.js';

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

const EXAMPLES = new Set(['.env.example', '.env.production.example']);
const files = envFiles.length
  ? envFiles
  : readdirSync(root)
      .filter((f) => /^\.env(\.[A-Za-z0-9_-]+)?$/.test(f) && !EXAMPLES.has(f))
      .map((f) => join(root, f));
if (!files.length) {
  console.log('[secret-guard] no local env file to compare against; nothing to check');
  process.exit(0);
}
const env: Record<string, string> = {};
for (const f of files) Object.assign(env, parseEnvText(readFileSync(f, 'utf8')));

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

const leaks = findLeaks(env, sources);
for (const l of leaks) console.error(`[secret-guard] the value of ${l.name} appears in ${l.source}`);
console.log(
  `[secret-guard] ${leaks.length ? 'LEAK' : 'clean'}: compared ${Object.keys(env).length} variables from ${files.length} env file(s) with ${sources.length} source(s)`,
);
process.exit(leaks.length ? 1 : 0);
