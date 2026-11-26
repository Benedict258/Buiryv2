#!/usr/bin/env bash
# Nightly logical backup on the VM (docs/DEPLOY_ORACLE.md, step 5). DESIGNED ONLY: not run on Oracle.
#
# Runs the repo's own scripts/backup/backup.sh against a local directory (file://), which writes
# buiry-<UTC>.dump, .dump.sha256 and .dump.json and checks the dump with pg_restore --list, then copies the
# directory off the box to OCI Object Storage. Started by buiry-backup.timer as the buiry-backup user.
#
# Environment (from /etc/buiry/backup.env, mode 600; names only here):
#   DATABASE_URL           the database to dump (a read-only role is enough)
#   BACKUP_DIR             local directory for dumps, e.g. /var/backups/buiry
#   BACKUP_RETENTION_DAYS  local dumps older than this are deleted by backup.sh
#   OCI_BACKUP_BUCKET      Object Storage bucket for the off-box copy (required: a backup that stays on the VM
#                          dies with the VM)
#   BUIRY_SRC              the checked-out repository, e.g. /opt/buiry/src
# Prints no secret: backup.sh prints file names, sizes and checks only.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BUIRY_SRC:?BUIRY_SRC is required}"
: "${OCI_BACKUP_BUCKET:?OCI_BACKUP_BUCKET is required (off-box copy)}"

mkdir -p "$BACKUP_DIR"
BACKUP_S3_URI="file://$BACKUP_DIR" bash "$BUIRY_SRC/scripts/backup/backup.sh"

# Off-box copy. UNVERIFIED: the OCI CLI flags below are from Oracle's CLI reference and have not been run here.
oci os object bulk-upload --bucket-name "$OCI_BACKUP_BUCKET" --src-dir "$BACKUP_DIR" --include 'buiry-*' --no-overwrite
echo "[backup] off-box copy finished"
