// SPDX-License-Identifier: Apache-2.0
import { BuiryError } from '@buiry/core';
import { parseArgs } from './args.js';
import { COMMANDS, UsageError } from './commands.js';
import type { Runtime } from './config.js';

export * from './api.js';
export * from './args.js';
export * from './commands.js';
export * from './config.js';
export * from './tools.js';

const HELP = (v: string) => `buiry ${v}: shared, verifiable project memory for AI coding agents

Usage: buiry <command> [options]

Commands:
${Object.entries(COMMANDS)
  .map(([k, c]) => `  ${k.padEnd(10)} ${c.summary}`)
  .join('\n')}

Global options: --json  --help
Environment: BUIRY_API_URL, BUIRY_TOKEN (override stored credentials)
`;

/** Runs the CLI. Returns the process exit code; never throws. */
export async function run(argv: string[], rt: Runtime): Promise<number> {
  const a = parseArgs(argv);
  if (a.flags.version === true) {
    rt.stdout('0.1.0\n');
    return 0;
  }
  const cmd = COMMANDS[a.command];
  if (!cmd || a.flags.help === true || a.command === 'help') {
    rt.stdout(HELP('0.1.0'));
    return cmd || a.command === 'help' ? 0 : 2;
  }
  try {
    return await cmd.run(a, rt);
  } catch (e) {
    if (e instanceof UsageError) {
      rt.stderr(`${e.message}\n`);
      return 2;
    }
    if (e instanceof BuiryError) {
      rt.stderr(
        `error (${e.code}): ${e.message}${e.retryAfterMs ? ` Retry in ${Math.ceil(e.retryAfterMs / 1000)}s.` : ''}\n`,
      );
      return e.code === 'unauthorized' ? 3 : 1;
    }
    rt.stderr(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
