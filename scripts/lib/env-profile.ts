/**
 * Explicit environment profiles (`.env.testnet`, `.env.mainnet`, ...). A profile is loaded only when named, and there
 * is no fallback to `.env`: a missing profile file is an error, so a testnet run can never pick up Mainnet keys.
 * Values are never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOW_MAINNET_VAR, checkNetworkEnv, normalizeSuiNetwork } from '../../packages/core/src/index.js';

/** Variables that decide which services and network a run talks to; the profile must own them all. */
export const PROFILE_OWNED = /^(WALRUS_|TATUM_|DEMO_|DATABASE_URL$|BUIRY_SECRET_KEY$)/;

/**
 * Quotes one argument for the Windows shell when it contains whitespace or quotes, so it reaches the program as one
 * argument. Plain arguments pass through unchanged.
 */
export function quoteForCmd(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Parses dotenv text: `NAME=value` lines, optional `export`, quotes stripped, CRLF-safe. Empty values are skipped. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (v) out[m[1]!] = v;
  }
  return out;
}

export interface LoadedProfile {
  name: string;
  file: string;
  /** Names only, for reporting. */
  names: string[];
  env: Record<string, string>;
}

/**
 * Loads `<root>/.env.<name>`. Refuses when the file is missing, when the name is a Sui network and the file names a
 * different one, or when the calling environment already sets a variable the profile owns (no silent mixing).
 */
export function loadProfile(
  root: string,
  name: string,
  callerEnv: Record<string, string | undefined>,
): LoadedProfile {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error(`invalid profile name "${name}" (use letters, digits, dashes)`);
  const file = join(root, `.env.${name}`);
  if (!existsSync(file))
    throw new Error(
      `profile file .env.${name} not found; it is never replaced by .env (see LOCAL_CHECKS.md)`,
    );
  const env = parseEnvText(readFileSync(file, 'utf8'));
  const expected = normalizeSuiNetwork(name);
  if (expected) {
    for (const k of ['WALRUS_NETWORK', 'TATUM_NETWORK', 'DEMO_NETWORK']) {
      const v = env[k];
      if (v && normalizeSuiNetwork(v) !== expected)
        throw new Error(`.env.${name} sets ${k}=${v}, which is not ${expected}`);
    }
  }
  const inherited = Object.keys(callerEnv).filter((k) => PROFILE_OWNED.test(k) && callerEnv[k] !== undefined);
  if (inherited.length)
    throw new Error(
      `the calling environment already sets ${inherited.sort().join(', ')}; unset them so only .env.${name} decides`,
    );
  // Phase 12 B: the mainnet opt-in belongs to the mainnet profile only, from the file or the calling shell.
  const optIn = env[ALLOW_MAINNET_VAR] ?? callerEnv[ALLOW_MAINNET_VAR];
  if (optIn !== undefined && expected !== 'mainnet')
    throw new Error(
      `${ALLOW_MAINNET_VAR} is set with profile ${name}; it belongs to the mainnet profile only`,
    );
  // A network profile must name its network, and every relayer host in it must agree (a testnet file carrying a
  // mainnet account is refused). Mainnet also needs the opt-in. The gateway's own check runs when a script builds it.
  if (expected) {
    const check = checkNetworkEnv(
      { ...env, ...(optIn !== undefined ? { [ALLOW_MAINNET_VAR]: optIn } : {}) },
      { requireNetwork: true, gatewayConfigured: false },
    );
    if (check.problems.length) throw new Error(`.env.${name} is inconsistent: ${check.problems.join('; ')}`);
  }
  return { name, file, names: Object.keys(env).sort(), env };
}
