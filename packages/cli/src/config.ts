// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseBuiryMd } from '@buiry/core';
import type { Credentials } from './api.js';

export interface Runtime {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  prompt: (question: string) => Promise<string>;
  /** Runs a command (used for git). Resolves with exit code and stdout; never throws. */
  exec: (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
}

export const credentialsPath = (home: string) => join(home, '.config', 'buiry', 'credentials.json');

export function loadCredentials(rt: Runtime): Credentials | null {
  const token = rt.env.BUIRY_TOKEN;
  const apiUrl = rt.env.BUIRY_API_URL;
  if (token && apiUrl) return { apiUrl, token };
  const p = credentialsPath(rt.home);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as Credentials;
    return c.apiUrl && c.token
      ? { apiUrl: rt.env.BUIRY_API_URL ?? c.apiUrl, token: rt.env.BUIRY_TOKEN ?? c.token }
      : null;
  } catch {
    return null;
  }
}

export function saveCredentials(rt: Runtime, c: Credentials): void {
  const p = credentialsPath(rt.home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...c, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}

export const buiryMdPath = (cwd: string) => join(cwd, 'BUIRY.md');

export function readProjectFile(
  cwd: string,
): { projectId: string; networks: string[]; source: string } | null {
  const p = buiryMdPath(cwd);
  if (!existsSync(p)) return null;
  const src = readFileSync(p, 'utf8');
  const parsed = parseBuiryMd(src);
  return parsed ? { projectId: parsed.meta.project, networks: parsed.meta.networks, source: src } : null;
}

/** Local CLI state (current branch). Never contains secrets. */
export function readState(cwd: string): { branch?: string } {
  try {
    return JSON.parse(readFileSync(join(cwd, '.buiry', 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}
export function writeState(cwd: string, s: { branch?: string }): void {
  mkdirSync(join(cwd, '.buiry'), { recursive: true });
  writeFileSync(join(cwd, '.buiry', 'state.json'), JSON.stringify(s));
  writeFileSync(join(cwd, '.buiry', '.gitignore'), '*\n');
}
