# Operations

What an operator must do to run Buiry without losing data. Deployment specifics (AWS) are in `docs/DEPLOYMENT.md` once written; this file states the requirements those must meet.

## The database must be backed up

Walrus holds the memory text, but only the database knows what that text means to Buiry. Without the database, the blobs on Walrus cannot be tied back to projects, branches, statuses or evidence, and some data exists nowhere else:

- **The map from memories to blobs**: `memories.walrus_blob_id`, `previous_blob_id` and the renewal generation, plus `write_jobs` (the exact stored text and idempotency keys that renewal rewrites).
- **Everything that is not written to Walrus**: workspaces, members, sessions, agents and their token hashes, projects, branches, flags, verifications, evidence, activity, webhooks, alert rules and plans.
- **Sealed secrets**: each project's own Walrus delegate key (`project_storage`) and webhook signing secrets. These are encrypted with a key derived from `BUIRY_SECRET_KEY`, so a backup is useless without that key. Back up the key separately (see key custody), and never in the same place as the database backup.
- **Queued writes**: memories accepted but not yet stored (`write_jobs` in `queued`, `submitting` or `submitted`). Losing them loses those memories.

Requirements:

1. Automated backups with point-in-time recovery (for example, RDS automated backups with a retention period chosen by the owner), plus a periodic logical dump kept in a separate account or region.
2. A restore test on a schedule the owner sets: restore into a scratch database, run `buiry doctor` against it, and check that a known memory's blob id still lists on the relayer.
3. `BUIRY_SECRET_KEY` held in a secrets manager with its own backup. Rotating it requires re-sealing `project_storage.delegate_key_sealed` and `webhooks.secret` first; there is no automatic re-seal yet.
4. Renewal (`BUIRY_RENEWAL=on`) depends on `write_jobs.text`: do not prune stored write jobs for memories that are still current.

## Storage lifetime and renewal

Walrus storage is paid for a fixed period (testnet about 5 days, Mainnet about 210 days as observed; see ASSUMPTIONS). The expiry scan reads each memory's expiry and raises a warning inside the margin. With `BUIRY_RENEWAL=on` it also queues a rewrite of each expiring memory: the same text is stored again as a new blob, the memory switches to it once stored, and the old blob stays until it lapses. Renewal costs the same as a new write on the account that stores the project (managed or the project's own).
