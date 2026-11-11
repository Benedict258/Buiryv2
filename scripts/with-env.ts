/**
 * Run a command with an explicit environment profile, never with `.env`:
 *   pnpm tsx scripts/with-env.ts testnet -- pnpm demo --live
 * Loads `.env.testnet` (gitignored), refuses if it is missing or names another network, and exports
 * BUIRY_ENV_PROFILE so logs can say which profile ran. Prints variable names only, never values.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './lib/env-profile.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const [name, sep, ...cmd] = process.argv.slice(2);
if (!name || sep !== '--' || cmd.length === 0) {
  console.error('usage: tsx scripts/with-env.ts <profile> -- <command> [args...]');
  process.exit(64);
}
try {
  const p = loadProfile(root, name, process.env);
  console.error(
    `[buiry] profile ${p.name}: ${p.names.length} variables from .env.${p.name} (${p.names.join(', ')})`,
  );
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ...p.env, BUIRY_ENV_PROFILE: p.name },
    shell: process.platform === 'win32',
  });
  process.exit(r.status ?? 1);
} catch (e) {
  console.error(`[buiry] ${(e as Error).message}`);
  process.exit(78);
}
