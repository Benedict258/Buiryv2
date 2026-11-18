#!/usr/bin/env bash
# Restore a Buiry logical backup into a database (docs/OPERATIONS.md, "Backups and recovery").
#
# Needs pg_restore and psql of the target server's major version, a dump made by pg_dump of that major version
# (all checked; a mismatch is refused), the AWS CLI (for s3://) and sha256sum.
#
# Required environment:
#   RESTORE_DATABASE_URL   the database to restore INTO (an empty or scratch database)
#   BACKUP_S3_URI          where the backups were written (s3://bucket/prefix or file:///dir)
# Optional:
#   BACKUP_OBJECT          a specific object name (buiry-<timestamp>.dump); default: the newest one
#   DATABASE_URL           the live database; restoring into it is refused unless ALLOW_RESTORE_OVER_LIVE=yes
#   BACKUP_WORK_DIR        scratch directory (default: a temporary directory)
#
# Steps: fetch the dump and its checksum, verify the checksum, restore with pg_restore (--clean --if-exists, no
# owners or privileges, stop on the first error), then print row counts (no content). Run the migration task
# against the restored database next.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
if [ -n "${DATABASE_URL:-}" ] && [ "$RESTORE_DATABASE_URL" = "$DATABASE_URL" ] && [ "${ALLOW_RESTORE_OVER_LIVE:-}" != "yes" ]; then
  echo "[restore] refusing to restore over the live database (set ALLOW_RESTORE_OVER_LIVE=yes to override)" >&2
  exit 2
fi
store_init
work="${BACKUP_WORK_DIR:-$(mktemp -d)}"

obj="${BACKUP_OBJECT:-}"
if [ -z "$obj" ]; then
  obj="$(store_list | grep -E '^buiry-[0-9]{8}T[0-9]{6}Z\.dump$' | sort | tail -n 1 || true)"
  if [ -z "$obj" ]; then echo "[restore] no backups found" >&2; exit 1; fi
fi
case "$obj" in buiry-*.dump) ;; *) echo "[restore] BACKUP_OBJECT must be a buiry-<timestamp>.dump name" >&2; exit 2 ;; esac
trap 'rm -f "$work/$obj" "$work/$obj.sha256" "$work/$obj.json"' EXIT

echo "[restore] fetching $obj"
store_get "$obj" "$work/$obj"
store_get "$obj.sha256" "$work/$obj.sha256"
store_get "$obj.json" "$work/$obj.json" || true
(cd "$work" && sha256sum --check --quiet "$obj.sha256")
echo "[restore] checksum ok"
if [ -f "$work/$obj.json" ]; then echo "[restore] metadata: $(cat "$work/$obj.json")"; fi

# The dump, the client and the target must share a major version (L-BAK1: pg_restore 18 into a 16 server failed).
target_major="$(server_major "$RESTORE_DATABASE_URL")"
restore_major="$(client_major pg_restore)"
dump_major="$(pg_restore --list "$work/$obj" | sed -nE 's/^;[[:space:]]+Dumped by pg_dump version: ([0-9]+).*/\1/p' | head -n 1)"
if [ -z "$dump_major" ]; then
  echo "[restore] refusing: cannot read the pg_dump version from $obj" >&2
  exit 3
fi
if [ "$dump_major" != "$target_major" ] || [ "$restore_major" != "$target_major" ]; then
  echo "[restore] refusing: the dump was made by pg_dump $dump_major, pg_restore is $restore_major and the target server is $target_major; all three must match (use client tools of the target's major version, Dockerfile.backup)" >&2
  exit 3
fi
echo "[restore] versions ok: dump, pg_restore and target are major version $target_major"

pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname "$RESTORE_DATABASE_URL" "$work/$obj"
echo "[restore] restored $obj"

# Row counts only (no content), to compare with the source.
psql "$RESTORE_DATABASE_URL" -At -c "select 'workspaces', count(*) from workspaces union all select 'projects', count(*) from projects union all select 'memories', count(*) from memories union all select 'stored_memories', count(*) from memories where walrus_blob_id is not null union all select 'write_jobs', count(*) from write_jobs union all select 'schema_migrations', count(*) from schema_migrations"
echo "[restore] next: run the migration task against this database, then start a server with the same BUIRY_SECRET_KEY generation"
