#!/usr/bin/env bash
# Off-site logical backup of the Buiry database (docs/OPERATIONS.md, "Backups and recovery").
#
# Runs in a scheduled ECS task (Dockerfile.backup, infra/aws/backup.tf) or a cron container that has pg_dump (same
# major version as the server or newer), the AWS CLI and sha256sum. Nothing secret is printed.
#
# Required environment:
#   DATABASE_URL           Postgres URL to dump (read-only access is enough)
#   BACKUP_S3_URI          s3://bucket/prefix (a bucket in a separate account or region), or file:///dir for tests
# Optional:
#   BACKUP_KMS_KEY_ID      KMS key for server-side encryption (default: the bucket's aws:kms default key)
#   BACKUP_RETENTION_DAYS  delete dumps older than this many days (unset: keep; the S3 lifecycle rule also applies)
#   BACKUP_KEY_GENERATION  label of the BUIRY_SECRET_KEY generation this dump needs (written to the metadata)
#   BACKUP_WORK_DIR        scratch directory (default: a temporary directory)
#
# Each run stores buiry-<UTC timestamp>.dump (pg_dump custom format), .dump.sha256 and .dump.json (metadata). The
# dump is checked with pg_restore --list before it is stored, and S3 uploads are encrypted (SSE-KMS).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
store_init

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="buiry-${stamp}.dump"
work="${BACKUP_WORK_DIR:-$(mktemp -d)}"
trap 'rm -f "$work/$name" "$work/$name.sha256" "$work/$name.json"' EXIT

echo "[backup] dumping database to $name"
pg_dump --format=custom --no-owner --no-privileges --file "$work/$name" "$DATABASE_URL"

# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$work/$name" > /dev/null

(cd "$work" && sha256sum "$name" > "$name.sha256")
size="$(wc -c < "$work/$name" | tr -d ' ')"
cat > "$work/$name.json" <<META
{"file":"$name","createdAt":"$stamp","bytes":$size,"format":"pg_dump custom","keyGeneration":"${BACKUP_KEY_GENERATION:-unlabelled}"}
META

for f in "$name" "$name.sha256" "$name.json"; do store_put "$work/$f" "$f"; done
echo "[backup] stored $name ($size bytes)"

if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
  case "$BACKUP_RETENTION_DAYS" in ''|*[!0-9]*) echo "[backup] BACKUP_RETENTION_DAYS must be a whole number" >&2; exit 2 ;; esac
  cutoff="$(date -u -d "-${BACKUP_RETENTION_DAYS} days" +%Y%m%dT%H%M%SZ)"
  # Object names carry their UTC timestamp, so retention compares names, not storage dates.
  store_list | grep -E '^buiry-[0-9]{8}T[0-9]{6}Z\.dump' | while read -r obj; do
    ts="${obj#buiry-}"; ts="${ts%%.*}"
    if [[ "$ts" < "$cutoff" ]]; then
      store_rm "$obj"
      echo "[backup] deleted $obj (older than ${BACKUP_RETENTION_DAYS} days)"
    fi
  done
fi
echo "[backup] done"
