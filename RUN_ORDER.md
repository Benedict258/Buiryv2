# Owner checks: run order

Every command below is copied from `LOCAL_CHECKS.md`, `docs/DEPLOYMENT.md` or `docs/OPERATIONS.md`. Where a command has not been run successfully end to end, it is marked **unverified**.

## Before you start

- **Use throwaway values.** Use generated passwords for throwaway databases (shown as `<local-only>`). Never paste real secrets into a check result.
- **This machine already runs a Postgres 17 service on port 5432.** Commands that publish a container on `5432:5432` will collide with it, and a URL pointing at `127.0.0.1:5432` would reach that existing server. Use a free host port instead; 55432 was used on 2026-11-18. Change only the port.
- **Postgres client tools must be version 16** to restore into a 16 server. Version 18 tools failed the restore (L-BAK1, below).

## 1. L-PG1: migrations, row-level security and the isolation suite on Postgres 16

**Status:** done 2026-11-18 on a throwaway `postgres:16-alpine` container (16.15) on host port 55432. Re-run only if the schema changes.

| Field      | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | Docker or a local Postgres 16; a superuser connection                                                                                                                                                                                                                                                                                                                                                         |
| Command    | `docker run -d --name buiry-pg16 -e POSTGRES_PASSWORD=<local-only> -p 5432:5432 postgres:16` (change the host port if 5432 is taken), then in PowerShell from the repo root: `$env:TEST_DATABASE_URL="postgres://postgres:<local-only>@127.0.0.1:5432/postgres"; corepack pnpm exec vitest run packages/api/test/postgres.test.ts packages/api/test/isolation.test.ts`. Afterwards: `docker rm -f buiry-pg16` |
| Expected   | `Tests  43 passed (43)`. LOCAL_CHECKS said 42 before Phase 2.6 added one isolation test.                                                                                                                                                                                                                                                                                                                      |
| Pass       | All passed, none skipped                                                                                                                                                                                                                                                                                                                                                                                      |
| Paste back | The `Tests` line                                                                                                                                                                                                                                                                                                                                                                                              |

Two notes:

- The `[L-PG1] Postgres 16.x: applied ...` line appears only with `--reporter=verbose --silent=false` added.
- That line prints `Postgres undefined`: the test reads the wrong column of `show server_version`. This is a cosmetic defect in the test; the migration ids it lists are correct.

## 2. L-BAK1: backup and restore round trip on Postgres

**Status: unverified.** On 2026-11-18 the backup half passed, and the restore failed because the client tools were version 18.

| Field      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | Docker, plus Postgres **16** client tools (`pg_dump`, `pg_restore`, `psql`, `createdb`) and `sha256sum`. No AWS for the local run.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Commands   | `docker run -d --name buiry-pg -e POSTGRES_PASSWORD=<local-only> -p 5432:5432 postgres:16`; `createdb` two databases `buiry_src` and `buiry_restore`; `DATABASE_URL=postgres://postgres:<local-only>@localhost:5432/buiry_src pnpm tsx packages/worker/src/migrate.ts`; `DATABASE_URL=... pnpm demo` (or write a few memories through the dev server on that database); `DATABASE_URL=<src> BACKUP_S3_URI=file:///tmp/buiry-backups bash scripts/backup/backup.sh`; `RESTORE_DATABASE_URL=<restore> BACKUP_S3_URI=file:///tmp/buiry-backups bash scripts/backup/restore.sh` |
| Expected   | "checksum ok" and row counts equal to `select count(*) ...` on the source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pass       | `restore.sh` exits 0, and its counts match the source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Paste back | Both outputs, without passwords                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Known problems:

- **The fill step does nothing.** `pnpm demo` and the dev server do not use `DATABASE_URL`, so they leave the source empty: 0 workspaces and 0 memories, only the 9 migration rows.
- **Version-18 tools fail the restore.** A dump made and restored with them fails on a 16 server with `unrecognized configuration parameter "transaction_timeout"`.

How to fill the source and which tools to use are owner decisions. They are not documented commands yet.

## 3. L-KEY1: secret key rotation on Postgres

**Status: not run.** The check also needs a webhook delivery and an own Walrus account connection, not just Postgres.

| Field      | Value                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | A Postgres with Buiry's schema (L-AWS1 or any local Postgres); a copy of the database with sealed secrets; two generated test keys; a webhook endpoint and an own-account relayer to confirm afterwards |
| Command    | The `rotate-key` task as in `docs/KEY_CUSTODY.md` steps 4 and 5, against a copy of the database                                                                                                         |
| Expected   | A dry-run report with counts, then `"committed":true`. A webhook delivery still verifies, and a project's own Walrus account still connects.                                                            |
| Pass       | Both JSON lines appear, and both follow-up checks work                                                                                                                                                  |
| Paste back | The two JSON lines (counts only)                                                                                                                                                                        |

## 4. L-BYO1: own Walrus account on testnet

**Status:** waiting for a second testnet Walrus Memory account. **Unverified.**

| Field      | Value                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs      | `WALRUS_BYO_TEST_RELAYER_URL`, `WALRUS_BYO_TEST_ACCOUNT_ID`, `WALRUS_BYO_TEST_DELEGATE_KEY` in `.env.testnet` (a second account, not the managed one)                                                                                |
| Command    | `pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/byo-live.ts`                                                                                                                                                               |
| Expected   | `connected own account`, two blob ids, the listing `{"ownBlobInOwnAccount":true,"ownBlobInManagedAccount":false,"managedBlobInManagedAccount":true,"managedBlobInOwnAccount":false}`, recall `true`, `PASS`. It writes two memories. |
| Pass       | `PASS`                                                                                                                                                                                                                               |
| Paste back | The output                                                                                                                                                                                                                           |

## 5. L-M1 (SMTP): one live sign-in email

**Status:** waiting for an SMTP account. **Unverified.**

| Field      | Value                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | An SMTP account (host, port, user, password, a From address on a domain you control)                                                           |
| Command    | Put `BUIRY_MAILER=smtp` and the `SMTP_*` names in a local env file, start the server, request a sign-in link for your own address, and open it |
| Expected   | One email with subject "Your Buiry sign-in link". The link signs you in once, and the server log shows no link or password.                    |
| Pass       | Received, signed in once, nothing secret in the log                                                                                            |
| Paste back | Received yes/no, sign-in worked yes/no, and the server log lines around the request                                                            |

## 6. L-AWS1: container image

**Status: unverified** (never built).

| Field      | Value                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | Docker and a Postgres                                                                                                                                                                                                                               |
| Command    | `docker build -t buiry .`; start Postgres; `docker run --rm -e DATABASE_URL=... buiry node dist-server/migrate.js`; then run the server with the settings in `.env.production.example` and `pnpm tsx scripts/smoke-deploy.ts http://localhost:8787` |
| Expected   | "applied 001_init, …". Every smoke check but https passes. Production settings now need `BUIRY_MANAGED_WORKSPACE_ID` or `BUIRY_MANAGED=off` (BD42).                                                                                                 |
| Pass       | Migrations applied; smoke passes except https                                                                                                                                                                                                       |
| Paste back | The outputs                                                                                                                                                                                                                                         |

## 7. L-AWS2: Terraform plan

**Status: unverified** (needs an AWS account).

| Field      | Value                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Needs      | An AWS account; your choices of region, domain, Sui network and RDS instance class (`docs/DEPLOYMENT.md` step 1) |
| Command    | `cd infra/aws && terraform init` (remote state of your choice), then `terraform plan -var-file=<your>.tfvars`    |
| Expected   | A plan summary. Leave `managed_workspace_id` empty for the first apply (BD42).                                   |
| Pass       | The plan matches `docs/DEPLOYMENT.md`, "Shape"                                                                   |
| Paste back | The plan summary line. Do not apply until the plan is reviewed.                                                  |

## 8. L-AWS3: deploy and smoke, testnet first

**Status: unverified.**

| Field      | Value                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs      | An applied stack; secrets set in Secrets Manager (`docs/DEPLOYMENT.md` step 5)                                                                                                                                                                                                                                                                                                                   |
| Commands   | Run the `migrate` task once (`aws ecs run-task` with the private subnets and the app security group); scale the `api` and `worker` services; `pnpm tsx scripts/smoke-deploy.ts https://<domain> --network <network>`; `curl -sI https://<domain>/`. Then the BD42 steps: sign in, copy the workspace id from the dashboard URL (`/w/wsp_.../projects`), set `managed_workspace_id`, apply again. |
| Expected   | Smoke passes. `curl` shows `strict-transport-security: max-age=31536000`, `content-security-policy` and `x-frame-options: DENY`.                                                                                                                                                                                                                                                                 |
| Pass       | All of the above, plus a memory from a connected agent reaches the Storage page as stored (`docs/DEPLOYMENT.md` step 8)                                                                                                                                                                                                                                                                          |
| Paste back | The smoke output and the `curl` header lines                                                                                                                                                                                                                                                                                                                                                     |

## 9. Restore drill on the deployed stack

**Status: unverified.**

| Field      | Value                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Needs      | The deployed stack; a dump or snapshot; the `BUIRY_SECRET_KEY` generation the dump needs                                                                                                                                                                                                                                                                     |
| Steps      | `docs/DEPLOYMENT.md` "Restore drill" and `docs/OPERATIONS.md` "Recovering from a dump": restore to a new instance or a scratch database; `RESTORE_DATABASE_URL` and `BACKUP_S3_URI` with `restore.sh`; run the migration task (`node dist-server/migrate.js`); start a server with that `DATABASE_URL`; `buiry doctor`; `buiry evidence` for a known project |
| Expected   | "checksum ok"; row counts; one known blob id still lists on the relayer                                                                                                                                                                                                                                                                                      |
| Pass       | Doctor is clean, and the known blob id is listed                                                                                                                                                                                                                                                                                                             |
| Paste back | `restore.sh` output (no URLs with passwords), doctor output                                                                                                                                                                                                                                                                                                  |

## 10. L-A1: OAuth sign-in (optional)

**Status: not run.**

| Field      | Value                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| Needs      | A GitHub OAuth app and a Google OAuth client registered under your accounts |
| Command    | None documented beyond the requirement                                      |
| Expected   | **Unverified**                                                              |
| Paste back | Whether sign-in worked for each provider                                    |
