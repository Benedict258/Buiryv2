#!/usr/bin/env bash
# Shared storage helpers for backup.sh and restore.sh. BACKUP_S3_URI is either s3://bucket/prefix (production:
# SSE-KMS encrypted uploads through the AWS CLI) or file:///absolute/dir (local testing only: no encryption).

store_init() {
  : "${BACKUP_S3_URI:?BACKUP_S3_URI is required}"
  prefix="${BACKUP_S3_URI%/}"
  case "$prefix" in
    s3://*) store_mode=s3 ;;
    file://*)
      store_mode=file
      store_dir="${prefix#file://}"
      # file:///C:/dir on Windows (Git Bash): drop the slash before the drive letter.
      case "$store_dir" in /[A-Za-z]:/*) store_dir="${store_dir#/}" ;; esac
      mkdir -p "$store_dir"
      echo "[backup] local destination $store_dir: not encrypted, for testing only" >&2
      ;;
    *) echo "[backup] BACKUP_S3_URI must start with s3:// or file://" >&2; exit 2 ;;
  esac
  sse=(--sse aws:kms)
  if [ -n "${BACKUP_KMS_KEY_ID:-}" ]; then sse+=(--sse-kms-key-id "$BACKUP_KMS_KEY_ID"); fi
}

# store_put <local file> <object name>
store_put() {
  if [ "$store_mode" = s3 ]; then aws s3 cp "$1" "$prefix/$2" "${sse[@]}" --only-show-errors
  else cp "$1" "$store_dir/$2"; fi
}

# store_get <object name> <local file>
store_get() {
  if [ "$store_mode" = s3 ]; then aws s3 cp "$prefix/$1" "$2" --only-show-errors
  else cp "$store_dir/$1" "$2"; fi
}

# store_list: object names, one per line
store_list() {
  if [ "$store_mode" = s3 ]; then aws s3 ls "$prefix/" | awk '{print $4}'
  else ls -1 "$store_dir"; fi
}

# store_rm <object name>
store_rm() {
  if [ "$store_mode" = s3 ]; then aws s3 rm "$prefix/$1" --only-show-errors
  else rm -f "$store_dir/$1"; fi
}
