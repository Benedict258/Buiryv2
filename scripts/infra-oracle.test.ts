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
  it('has the templates the guide installs', () => {
    expect(files.sort()).toEqual([
      'Caddyfile.template',
      'backup-local.sh',
      'build-artifact.sh',
      'buiry-backup.service',
      'buiry-backup.timer',
      'buiry.service',
      'check-artifact-deps.cjs',
      'postgresql-1gb.conf.template',
      'swap.sh',
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
  it("reuses the repo's backup.sh with a local store, and fails loudly while the off-box copy is not configured", () => {
    expect(sh).toContain('set -euo pipefail');
    expect(sh).toContain('BACKUP_S3_URI="file://$BACKUP_DIR" bash "$BUIRY_SRC/scripts/backup/backup.sh"');
    // The local dump comes first; an unset bucket then ends the run with a non-zero exit, never a silent skip.
    expect(sh.indexOf('scripts/backup/backup.sh')).toBeLessThan(
      sh.indexOf('if [ -z "${OCI_BACKUP_BUCKET:-}" ]'),
    );
    expect(sh).toMatch(
      /if \[ -z "\$\{OCI_BACKUP_BUCKET:-\}" \]; then\n[^\n]*OFF-BOX COPY NOT CONFIGURED[^\n]*\n\s+exit 3/,
    );
  });
  it('the backup service runs the ops copy shipped in the artefact', () => {
    expect(read('buiry-backup.service')).toMatch(
      /^ExecStart=\/bin\/bash \/opt\/buiry\/app\/ops\/infra\/oracle\/backup-local\.sh$/m,
    );
  });
  it.each(['backup-local.sh', 'swap.sh', 'build-artifact.sh'])('%s is valid bash', (f) => {
    expect(() => execFileSync('bash', ['-n', join(dir, f)], { stdio: 'pipe' })).not.toThrow();
  });
});

// Phase 16b: the 1 core, 1 GB profile.
describe('1 GB profile limits', () => {
  it('caps the JS heap and the whole service', () => {
    const unit = read('buiry.service');
    expect(unit).toMatch(
      /^ExecStart=\/usr\/local\/bin\/node --max-old-space-size=256 dist-server\/server\.js$/m,
    );
    expect(unit).toMatch(/^MemoryMax=450M$/m);
    expect(unit).toMatch(/^MemoryHigh=400M$/m);
  });
  it('tunes Postgres for 1 GB on the loopback only', () => {
    const pg = read('postgresql-1gb.conf.template');
    for (const line of [
      "listen_addresses = 'localhost'",
      'max_connections = 20',
      'shared_buffers = 128MB',
      'work_mem = 4MB',
      'maintenance_work_mem = 32MB',
      'jit = off',
    ])
      expect(pg).toContain(line);
    expect(pg).not.toMatch(/listen_addresses\s*=\s*'\*'/);
  });
  it('creates a 2 GB swap file only when no swap is active', () => {
    const sw = read('swap.sh');
    expect(sw).toContain('SWAP_SIZE_MB=2048');
    expect(sw.indexOf('swapon --noheadings --show=NAME')).toBeLessThan(sw.indexOf('fallocate'));
    expect(sw).toContain('vm.swappiness=10');
  });
});

describe('build-artifact.sh', () => {
  const b = read('build-artifact.sh');
  it('builds off the VM from a clean tree, with production dependencies only', () => {
    expect(b).toMatch(/git status --porcelain/);
    expect(b).toMatch(/deploy --prod --legacy --config\.node-linker=hoisted/);
    // Dev tools are refused unless a production package requires them (scripts/artifact-deps.test.ts).
    expect(b).toContain('node "$(dirname "$0")/check-artifact-deps.cjs" "$APP"');
  });
  it('ships the built output, the lockfile and a checksum, and refuses any env file or key', () => {
    for (const s of ['dist-server', 'proto', 'dashboard', 'cp pnpm-lock.yaml', 'sha256sum', 'MANIFEST'])
      expect(b).toContain(s);
    expect(b).toMatch(/-name '\.env' -o -name '\.env\.\*' -o -name '\*\.pem' -o -name '\*\.key'/);
    expect(b).toMatch(/refusing" >&2\n\s+exit 3/);
  });
});
