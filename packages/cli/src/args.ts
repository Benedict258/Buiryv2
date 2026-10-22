// SPDX-License-Identifier: Apache-2.0

export interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN = new Set([
  'json',
  'yes',
  'y',
  'print',
  'onboarding',
  'confirm',
  'help',
  'h',
  'version',
  'no-pointer',
  'project-scope',
  'include-proposed',
]);

/** Minimal parser: `cmd [positionals] --flag value --bool`. Flags may also be `--flag=value`. */
export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (BOOLEAN.has(k)) flags[k] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[k] = true;
        else {
          flags[k] = next;
          i++;
        }
      }
    } else if (a === '-h') flags.help = true;
    else if (a === '-y') flags.yes = true;
    else positionals.push(a);
  }
  const [command = 'help', ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export const str = (f: Record<string, string | boolean>, k: string): string | undefined =>
  typeof f[k] === 'string' ? (f[k] as string) : undefined;
