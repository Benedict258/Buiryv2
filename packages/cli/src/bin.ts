#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { run } from './index.js';

const exec = (cmd: string, args: string[], cwd: string) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('error', () => resolve({ code: 127, stdout: '' }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });

const code = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: process.cwd(),
  home: homedir(),
  env: process.env,
  fetch,
  exec,
  prompt: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
});
// Setting exitCode (instead of process.exit) lets pending handles close; on Windows an early exit aborts with a libuv assertion and a non-zero status.
process.exitCode = code;
