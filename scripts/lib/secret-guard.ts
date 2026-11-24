/**
 * Secret guard (pure part). Given the secret values from the local env files and some texts, reports which
 * variable's value appears where. Results carry variable NAMES and locations only, never a value or any part of one.
 */

/** Variables whose values are secret. Anything ending in KEY, TOKEN, SECRET or PASSWORD counts too. */
export const SECRET_NAMES = new Set([
  'DATABASE_URL',
  'RESTORE_DATABASE_URL',
  'BUIRY_SECRET_KEY',
  'BUIRY_SECRET_KEY_PREVIOUS',
  'WALRUS_DELEGATE_KEY',
  'WALRUS_BYO_TEST_DELEGATE_KEY',
  'PROOF_DELEGATE_KEY',
  'BYO_A_DELEGATE_KEY',
  'BYO_B_DELEGATE_KEY',
  'BUIRY_PROOF_TOKEN',
  'BUIRY_TOKEN',
  'SMTP_PASSWORD',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
]);
const SECRET_SUFFIX = /(KEY|TOKEN|SECRET|PASSWORD)$/;
/** Shorter values match ordinary text too often to be meaningful. */
export const MIN_SECRET_LENGTH = 8;

export function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(name) || SECRET_SUFFIX.test(name);
}

/**
 * The strings to look for, per variable. A database URL is checked whole and for its password part on its own, since
 * a password can leak without the rest of the URL.
 */
export function secretNeedles(env: Record<string, string>): { name: string; needle: string }[] {
  const out: { name: string; needle: string }[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (!isSecretName(name)) continue;
    const value = raw.trim();
    if (value.length >= MIN_SECRET_LENGTH) out.push({ name, needle: value });
    if (/^postgres(ql)?:\/\//.test(value)) {
      try {
        const pw = decodeURIComponent(new URL(value).password);
        if (pw.length >= MIN_SECRET_LENGTH) out.push({ name: `${name} (password part)`, needle: pw });
      } catch {
        // not a parseable URL: the whole value is still checked
      }
    }
  }
  return out;
}

export interface Leak {
  name: string;
  source: string;
}

/** Every (variable, source) pair where the variable's value occurs in the source text. Names and sources only. */
export function findLeaks(env: Record<string, string>, sources: { source: string; text: string }[]): Leak[] {
  const needles = secretNeedles(env);
  const leaks: Leak[] = [];
  for (const s of sources)
    for (const n of needles) if (s.text.includes(n.needle)) leaks.push({ name: n.name, source: s.source });
  return leaks;
}

/** Added lines of a unified diff, grouped by file, as sources. Removed lines are not a leak. */
export function addedLinesByFile(diff: string): { source: string; text: string }[] {
  const out = new Map<string, string[]>();
  let file = '(unknown file)';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      const list = out.get(file) ?? [];
      list.push(line.slice(1));
      out.set(file, list);
    }
  }
  return [...out].map(([source, lines]) => ({ source: `staged ${source}`, text: lines.join('\n') }));
}

/** The committed examples; every other `.env` or `.env.<name>` (such as `.env.testnet`, `.env.mainnet`) is local. */
export const ENV_EXAMPLES = new Set(['.env.example', '.env.production.example']);

/** A local env file by its base name: `.env` or `.env.<name>`, except the committed examples. */
export function isLocalEnvFile(name: string): boolean {
  return /^\.env(\.[A-Za-z0-9_-]+)?$/.test(name) && !ENV_EXAMPLES.has(name);
}

/** Staged paths that are local env files, anywhere in the tree. The pre-commit hook refuses the commit for these. */
export function stagedEnvFiles(paths: string[]): string[] {
  return paths.filter((p) => isLocalEnvFile(p.split('/').pop() ?? ''));
}
