#!/usr/bin/env bash
# Nightly logical backup on the VM (docs/DEPLOY_ORACLE.md, step 5). DESIGNED ONLY: not run on Oracle.
#
# Runs the repo's own scripts/backup/backup.sh (shipped in the artefact under ops/) against a local directory
# (file://), which writes buiry-<UTC>.dump, .dump.sha256 and .dump.json and checks the dump with pg_restore --list.
# Then it copies the directory off the box to OCI Object Storage. Until OCI_BACKUP_BUCKET is configured, the local
# dump is still made and the run then exits non-zero, so the timer shows the missing off-box copy instead of hiding it.
# Started by buiry-backup.timer as the buiry-backup user.
#
# Environment (from /etc/buiry/backup.env, mode 600; names only here):
#   DATABASE_URL           the database to dump (a read-only role is enough)
#   BACKUP_DIR             local directory for dumps, e.g. /var/backups/buiry
#   BACKUP_RETENTION_DAYS  local dumps older than this are deleted by backup.sh
#   BUIRY_SRC              where the ops scripts are, e.g. /opt/buiry/app/ops
#   OCI_BACKUP_BUCKET      Object Storage bucket for the off-box copy (a backup that stays on the VM dies with the VM)
# Prints no secret: backup.sh prints file names, sizes and checks only.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BUIRY_SRC:?BUIRY_SRC is required}"

mkdir -p "$BACKUP_DIR"
BACKUP_S3_URI="file://$BACKUP_DIR" bash "$BUIRY_SRC/scripts/backup/backup.sh"

if [ -z "${OCI_BACKUP_BUCKET:-}" ]; then
  echo "[backup] local dump done; OFF-BOX COPY NOT CONFIGURED (set OCI_BACKUP_BUCKET): this backup stays on the VM" >&2
  exit 3
fi
# Off-box copy. UNVERIFIED: the OCI CLI flags below are from Oracle's CLI reference and have not been run here.
oci os object bulk-upload --bucket-name "$OCI_BACKUP_BUCKET" --src-dir "$BACKUP_DIR" --include 'buiry-*' --no-overwrite
echo "[backup] off-box copy finished"
