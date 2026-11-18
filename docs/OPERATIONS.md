# Operations

What an operator must do to run Buiry without losing data. Deployment specifics (AWS) are in `docs/DEPLOYMENT.md`; this file states the requirements they must meet.

## The database must be backed up

Walrus holds the memory text, but only the database knows what that text means to Buiry. Without the database, the blobs on Walrus cannot be tied back to projects, branches, statuses or evidence, and some data exists nowhere else:

- **The map from memories to blobs**: `memories.walrus_blob_id`, `previous_blob_id` and the renewal generation, plus `write_jobs` (the exact stored text and idempotency keys that renewal rewrites).
- **Everything that is not written to Walrus**: workspaces, members, sessions, agents and their token hashes, projects, branches, flags, verifications, evidence, activity, webhooks, alert rules and plans.
- **Sealed secrets**: each project's own Walrus delegate key (`project_storage`) and webhook signing secrets. These are encrypted with a key derived from `BUIRY_SECRET_KEY`, so a backup is useless without that key. Back up the key separately (see key custody), and never in the same place as the database backup.
- **Queued writes**: memories accepted but not yet stored (`write_jobs` in `queued`, `submitting` or `submitted`). Losing them loses those memories.

Requirements:

1. Automated backups with point-in-time recovery (for example, RDS automated backups with a retention period chosen by the owner), plus a periodic logical dump kept in a separate account or region.
2. A restore test on a schedule the owner sets: restore into a scratch database, run `buiry doctor` against it, and check that a known memory's blob id still lists on the relayer.
3. `BUIRY_SECRET_KEY` held in a secrets manager with its own backup. Rotation follows the runbook in `docs/KEY_CUSTODY.md` (`dist-server/rotate-key.js` re-seals stored secrets; `BUIRY_SECRET_KEY_PREVIOUS` keeps tokens working during the overlap). Label each backup with the key generation it needs.
4. Renewal (`BUIRY_RENEWAL=on`) depends on `write_jobs.text`: do not prune stored write jobs for memories that are still current.

## Backups and recovery

Two layers:

- **Point-in-time recovery** (RDS automated backups, `db_backup_retention_days`): for mistakes and corruption inside the retention window.
- **Off-site logical dumps** (`scripts/backup/backup.sh`, run daily by the scheduled task in `infra/aws/backup.tf`): `pg_dump` archives in an encrypted, versioned bucket with a lifecycle rule (`backup_retention_days`). Each dump has a checksum and a metadata file naming the `BUIRY_SECRET_KEY` generation it needs. For protection against losing the AWS account or region, put the bucket in another account or region.

### Recovering from a dump

1. **Choose the dump.** The newest one, or a named `buiry-<timestamp>.dump`. Note its key generation in the `.json` file.
2. **Create an empty database.** Use a new RDS instance or a scratch database; never the damaged live one.
3. **Run `restore.sh`** with `RESTORE_DATABASE_URL` and `BACKUP_S3_URI` (the backup image: `docker run ... buiry-backup restore.sh`). It:
   - verifies the checksum, restores, and prints row counts;
   - refuses to restore over the live database unless `ALLOW_RESTORE_OVER_LIVE=yes`.
4. **Run the migration task** (`node dist-server/migrate.js`) against the restored database. The dump may predate later migrations.
5. **Start the services** with `DATABASE_URL` pointing at the restored database and the `BUIRY_SECRET_KEY` generation the dump needs. A dump from before a key rotation needs the old key, or the old key as `BUIRY_SECRET_KEY_PREVIOUS`.
6. **Check:**
   - `buiry doctor`;
   - the Storage page of a project, where stored memories show their blob ids;
   - one known blob id still lists on the relayer (`buiry evidence`);
   - a test webhook delivery.
7. **Replay the gap.** Writes accepted after the dump's timestamp are not in the restored database. See what is lost, below.

### What is lost if the database is lost (and no dump exists)

- **The meaning of the data on Walrus.**
  - The map from memories to blobs (`walrus_blob_id`, `previous_blob_id`, renewal generation).
  - Statuses, confidence, evidence and verifications, flags, branches, handoffs and activity.
  - Walrus keeps the memory text in each project's namespace. The relayer's listing and `restore` can re-index it, but Buiry cannot rebuild statuses or evidence from it.
- **The source for renewal.** `write_jobs.text` holds the exact stored text that renewal rewrites. Without it, memories cannot be renewed and lapse at their end epoch.
- **Queued writes.** Memories accepted but not yet stored on Walrus.
- **Accounts and access.**
  - Users, members, sessions and invitations.
  - Agent and API token hashes, so every agent must be reconnected.
  - Webhooks and alert rules, and plans.
- **Sealed secrets.** Per-project Walrus delegate keys and webhook signing secrets. Project admins must reconnect their accounts and recreate webhooks.
- **What is lost after restoring a dump:** everything written after the dump's timestamp. Memories stored on Walrus in that window exist on Walrus but are unknown to the restored database. Re-indexing them from the relayer listing is not built.

## Storage lifetime and renewal

Walrus storage is paid for a fixed period (testnet about 5 days, Mainnet about 210 days as observed; see ASSUMPTIONS). The expiry scan reads each memory's expiry and raises a warning inside the margin. With `BUIRY_RENEWAL=on` it also queues a rewrite of each expiring memory: the same text is stored again as a new blob, the memory switches to it once stored, and the old blob stays until it lapses. Renewal costs the same as a new write on the account that stores the project (managed or the project's own).
