import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phase 16 C: the Oracle VM templates in infra/oracle are placeholders only (docs/DEPLOY_ORACLE.md, DESIGNED ONLY).
// These checks run offline: no template carries a secret, a real address or a real hostname, and each keeps the
// settings the guide relies on.

const dir = fileURLToPath(new URL('../infra/oracle/', import.meta.url));
const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

describe('infra/oracle templates: placeholders only', () => {
  it('has the five templates the guide installs', () => {
    expect(files.sort()).toEqual([
      'Caddyfile.template',
      'backup-local.sh',
      'buiry-backup.service',
      'buiry-backup.timer',
      'buiry.service',
    ]);
  });

  it.each(files)('%s carries no secret value, real address or real hostname', (f) => {
    const text = read(f);
    // No NAME=value for anything secret-looking (names alone, in comments, are fine).
    expect(text).not.toMatch(/(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=\S/);
    expect(text).not.toMatch(/postgres(ql)?:\/\/\S+@/);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{16,}/);
    // The only IPv4 address is the loopback the proxy talks to.
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) expect(ip, f).toBe('127.0.0.1');
    // No hostname with a public suffix other than the reserved example.com.
    for (const host of text.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|xyz|ai|app|dev|cloud)\b/gi) ??
      [])
      expect(host.toLowerCase(), f).toMatch(/(^|\.)example\.com$/);
    expect(text).toContain('DESIGNED ONLY');
  });
});

describe('buiry.service', () => {
  const unit = read('buiry.service');
  it('runs as the non-root buiry user from a locked-down env file, restarts on failure and is hardened', () => {
    expect(unit).toMatch(/^User=buiry$/m);
    expect(unit).not.toMatch(/^User=root$/m);
    expect(unit).toMatch(/^EnvironmentFile=\/etc\/buiry\/buiry\.env$/m);
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).toMatch(/^StartLimitBurst=\d+$/m);
    for (const h of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes'])
      expect(unit).toContain(h);
  });
  it('sets no secret, no network and no managed or mainnet switch itself', () => {
    const envLines = unit.split('\n').filter((l) => l.startsWith('Environment='));
    expect(envLines.map((l) => l.split('=')[1])).toEqual([
      'NODE_ENV',
      'PORT',
      'BUIRY_PROTO_ROOT',
      'DASHBOARD_DIR',
    ]);
    expect(unit).not.toMatch(/BUIRY_MANAGED_MULTI_TENANT|BUIRY_ALLOW_MAINNET|WALRUS_NETWORK|BUIRY_PREVIEW/);
  });
});

describe('Caddyfile.template', () => {
  const caddy = read('Caddyfile.template');
  it('proxies to the loopback port only, with the domain as a placeholder', () => {
    expect(caddy).toMatch(/^\{\$BUIRY_DOMAIN\} \{/m);
    expect(caddy).toMatch(/reverse_proxy 127\.0\.0\.1:8787/);
    expect(caddy).toMatch(/flush_interval -1/);
  });
  it('keeps no access log, since sign-in links carry a token in the URL', () => {
    const directives = caddy
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(directives).not.toMatch(/\blog\b/);
  });
});

describe('backup-local.sh', () => {
  const sh = read('backup-local.sh');
  it("reuses the repo's backup.sh with a local store and requires an off-box copy", () => {
    expect(sh).toContain('set -euo pipefail');
    expect(sh).toContain('BACKUP_S3_URI="file://$BACKUP_DIR" bash "$BUIRY_SRC/scripts/backup/backup.sh"');
    expect(sh).toMatch(/: "\$\{OCI_BACKUP_BUCKET:\?/);
  });
  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', join(dir, 'backup-local.sh')], { stdio: 'pipe' })).not.toThrow();
  });
});
