import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phase C: the backup and restore scripts, run with stand-in pg_dump, pg_restore, psql and aws commands so the
// orchestration (encryption flags, checksum, metadata, retention, refusals) is tested without Postgres or AWS.
// The real round trip against Postgres and S3 is LOCAL_CHECKS L-BAK1.

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' ? (existsSync(GIT_BASH) ? GIT_BASH : null) : 'bash';
const PASSWORD = 'pw-not-real-123';

/** Stand-ins: pg_dump writes a fixed archive; aws maps s3://fake-bucket to a local directory. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'buiry-backup-test-'));
  const bin = join(root, 'bin');
  const s3 = join(root, 's3');
  mkdirSync(bin);
  mkdirSync(join(s3, 'prefix'), { recursive: true });
  const log = join(root, 'calls.log');
  const stub = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\necho "${name} $*" >> "${log.replace(/\\/g, '/')}"\n${body}\n`,
      {
        mode: 0o755,
      },
    );
  stub(
    'pg_dump',
    'while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then printf "PGDMP-fake-archive" > "$2"; fi; shift; done',
  );
  stub('pg_restore', 'exit 0');
  stub('psql', 'echo "memories|3"');
  stub(
    'aws',
    `S3="${s3.replace(/\\/g, '/')}"
map() { echo "$1" | sed "s#^s3://fake-bucket#$S3#"; }
case "$2" in
  cp) src="$3"; dst="$4"; case "$src" in s3://*) src="$(map "$src")";; esac; case "$dst" in s3://*) dst="$(map "$dst")";; esac
      [ -f "$src" ] || exit 1; cp "$src" "$dst";;
  ls) d="$(map "$3")"; for f in $(ls "$d"); do echo "2026-01-01 00:00:00 10 $f"; done;;
  rm) rm -f "$(map "$3")";;
esac`,
  );
  const run = (script: string, env: Record<string, string>) => {
    const r = spawnSync(BASH!, [join(HERE, script).replace(/\\/g, '/')], {
      env: {
        ...process.env,
        PATH: `${bin.replace(/\\/g, '/')}:${process.env.PATH}`,
        BACKUP_WORK_DIR: root.replace(/\\/g, '/'),
        ...env,
      },
      encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const objects = () => readdirSync(join(s3, 'prefix')).sort();
  return { root, s3: join(s3, 'prefix'), run, calls, objects };
}

const DB = `postgres://buiry:${PASSWORD}@db.internal:5432/buiry`;

describe.skipIf(!BASH)('backup and restore scripts', () => {
  it('dumps, checks the archive, uploads encrypted with a checksum and metadata, and prunes old dumps', async () => {
    const w = world();
    writeFileSync(join(w.s3, 'buiry-20200101T000000Z.dump'), 'old');
    const r = w.run('backup.sh', {
      DATABASE_URL: DB,
      BACKUP_S3_URI: 's3://fake-bucket/prefix',
      BACKUP_KMS_KEY_ID: 'alias/buiry-backups',
      BACKUP_RETENTION_DAYS: '30',
      BACKUP_KEY_GENERATION: 'gen-2',
    });
    expect(r.code, r.out).toBe(0);
    const objs = w.objects();
    expect(objs.filter((o) => o.endsWith('.dump'))).toHaveLength(1); // the 2020 dump was pruned
    const dump = objs.find((o) => o.endsWith('.dump'))!;
    expect(objs).toEqual(expect.arrayContaining([`${dump}.sha256`, `${dump}.json`]));
    expect(JSON.parse(readFileSync(join(w.s3, `${dump}.json`), 'utf8'))).toMatchObject({
      keyGeneration: 'gen-2',
    });
    const calls = w.calls();
    expect(calls).toMatch(/pg_restore --list/);
    expect(calls.match(/aws s3 cp .* --sse aws:kms --sse-kms-key-id alias\/buiry-backups/g)).toHaveLength(3);
    expect(r.out).not.toContain(PASSWORD);
  });

  it('restores the newest dump after verifying its checksum, and refuses a tampered one', async () => {
    const w = world();
    expect(w.run('backup.sh', { DATABASE_URL: DB, BACKUP_S3_URI: 's3://fake-bucket/prefix' }).code).toBe(0);
    const target = 'postgres://buiry:other@scratch.internal:5432/restore_test';
    const ok = w.run('restore.sh', {
      RESTORE_DATABASE_URL: target,
      BACKUP_S3_URI: 's3://fake-bucket/prefix',
    });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain('checksum ok');
    expect(ok.out).toContain('memories|3');
    expect(w.calls()).toMatch(
      /pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname/,
    );

    const dump = w.objects().find((o) => o.endsWith('.dump'))!;
    writeFileSync(join(w.s3, dump), 'tampered');
    const before = (w.calls().match(/pg_restore --clean/g) ?? []).length;
    const bad = w.run('restore.sh', {
      RESTORE_DATABASE_URL: target,
      BACKUP_S3_URI: 's3://fake-bucket/prefix',
    });
    expect(bad.code).not.toBe(0);
    expect((w.calls().match(/pg_restore --clean/g) ?? []).length).toBe(before); // nothing restored
  });

  it('round-trips through a local file:// destination without the AWS CLI (local testing)', () => {
    const w = world();
    const dir = join(w.root, 'local-store').replace(/\\/g, '/');
    const uri = `file://${dir.startsWith('/') ? '' : '/'}${dir}`;
    const b = w.run('backup.sh', { DATABASE_URL: DB, BACKUP_S3_URI: uri });
    expect(b.code, b.out).toBe(0);
    expect(b.out).toContain('not encrypted, for testing only');
    const r = w.run('restore.sh', { RESTORE_DATABASE_URL: 'postgres://x@scratch/db', BACKUP_S3_URI: uri });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('checksum ok');
    expect(w.calls()).not.toMatch(/^aws /m);
  });

  it('refuses to restore over the live database', () => {
    const w = world();
    const r = w.run('restore.sh', {
      RESTORE_DATABASE_URL: DB,
      DATABASE_URL: DB,
      BACKUP_S3_URI: 's3://fake-bucket/prefix',
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain('refusing to restore over the live database');
    expect(r.out).not.toContain(PASSWORD);
  });
});
