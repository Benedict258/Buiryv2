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

## API tokens: expiry and the confirm scope

- **Expiry.** API tokens expire after 90 days unless the creator asks for a different number of days (1 to 365, `expiresInDays`). Agent tokens expire after `BUIRY_AGENT_TOKEN_MAX_DAYS` (default 90).
- **Before any tester gets access.** No deployed environment exists yet. On the first deployed database, run the migration below as a dry run, send the owner the output, and apply it only after the owner's go-ahead. Until then finding M4 stays partly fixed.
- **Old tokens.** Tokens created before those changes may have no expiry. `scripts/real-pg/token-expiry.ts` lists them (dry run, counts and scopes only) and, with `--apply`, gives each active one an expiry 90 days out, in one transaction. It never adds the confirm scope.
- **The confirm scope.** Confirming a memory, creating one as confirmed and merging as confirmed need the explicit `confirm` scope, which is off by default. A token without it gets 403 "this API token lacks the confirm scope" and its merges bring memories in as proposed.
- **Reissuing a token that must confirm** (the owner or an admin):
  1. Create a new token with the scopes it needs plus `confirm`: `POST /v1/workspaces/<ws>/api-tokens` with `{"name": "...", "scopes": ["read", "write", "confirm"], "expiresInDays": 90}` and a signed-in session. The token is shown once.
  2. Put it where the old one was used, and check one confirm works.
  3. Revoke the old token: `DELETE /v1/api-tokens/<id>`.
  4. Never give a token with `confirm` to an agent tool: it would confirm as a person (`docs/SECURITY_REVIEW.md`, M8).
- The dashboard's API token page does not yet offer the `confirm` scope or show expiry (`docs/design/02`); until it does, use the API call above.

## Preview mode (bring your own storage)

- `BUIRY_PREVIEW=1` with `BUIRY_MANAGED=off`. The server refuses to start in preview mode if `BUIRY_MANAGED` is not `off`, or if `BUIRY_MANAGED_MULTI_TENANT=1` or `BUIRY_MANAGED_WORKSPACE_ID` is set, in every environment.
- Whenever the deployment has no shared storage account (preview or not), a project without its own account refuses writes up front: 403, "this deployment has no shared Walrus account, ...". Nothing is queued. The dashboard shows a banner pointing to the Storage page.
- **Writes queued before this rule** for such projects are not deleted. At startup the server logs one warning with their count and project ids ("[buiry] N queued writes in M projects cannot be stored: ..."). They are stored once each project connects its own account. To see them: `strandedWrites` in `packages/api/src/service/byo-storage.ts`.
- Testers follow `docs/TESTER_ONBOARDING.md`.

## Writes while the relayer struggles (Phase 10)

**Retry policy.** The relayer's own guidance for a failed write is "keep polling a job; do not resubmit unless the job reaches failed; retry after a few minutes". The write drain follows it (`packages/storage/src/write-worker.ts`):

- **Wait after a failed attempt.** At least 10 minutes, doubling per attempt, capped at 2 hours, with up to 25% added jitter (`relayerBackoffMs`). Attempts land at about 0, 10, 30 and 70 minutes, so no hour holds more than three. A relayer `retry-after` longer than that is honoured.
- **Degraded pause.** While the relayer's `/health` reports writes `degraded` or `paused`, nothing new is submitted. Jobs already submitted are still polled to the end.
- **Give-up.** Unchanged: after 6 attempts the job is `dead`, the memory's write state becomes `failed`, and a `failed_write` flag shows in Alerts and briefings. A memory is marked `stored` only when the relayer reports its job done.
- **Recorded reason.** A failed relayer job records a fixed reason, never the relayer's text:
  - "job_failed: the storage relayer was reachable and reported a temporary capacity limit";
  - or "... reported the write job as failed".

**Notice in preview.** Every minute the worker probes each project's own relayer (`ownRelayerProbe`). While writes are degraded, paused or the relayer is unreachable, that project gets a `relayer` flag, which shows in Alerts and in briefings. The flag is resolved when writes are `ok`. The shared-account probe no longer flags projects that have their own account.

**Tracing a failed write with Walrus support.** Each write job logs `event: write_job` lines with the relayer job id and every status change (submitted, pending, running, failed, retry_scheduled, stored, dead), the attempt and a UTC time. They carry no text and no namespace. Give support the relayer job ids and times.

**Notice after failed writes (Phase 10 F5).** After 2 consecutive failed write attempts for a project, it gets a `write_failures` notice in Alerts and briefings. The notice does not depend on the relayer's `/health`, which reported `ok` for hours on 2026-11-23 while every write failed. It is cleared by the next stored write. The text is fixed, with no relayer text. The count is kept in memory per drain, so a restart starts counting again; an open notice stays until a write is stored. Migration `010_flag_write_failures` adds the flag kind.

**Health is not enough.** Treat `/health` reporting writes `ok` as necessary, not sufficient. Use the write canary (`docs/LIVE_PROOF.md`) to confirm that writes are actually stored.
