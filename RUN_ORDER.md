# Owner checks: run order

Every command below is copied from `LOCAL_CHECKS.md`, `docs/DEPLOYMENT.md` or `docs/OPERATIONS.md`. Where a command has not been run successfully end to end, it is marked **unverified**.

## Before you start

- **Use throwaway values.** Use generated passwords for throwaway databases (shown as `<local-only>`). Never paste real secrets into a check result.
- **This machine already runs a Postgres 17 service on port 5432.** Commands that publish a container on `5432:5432` will collide with it, and a URL pointing at `127.0.0.1:5432` would reach that existing server. Use a free host port instead; 55432 was used on 2026-11-18. Change only the port.
- **Postgres client tools must be version 16** to restore into a 16 server. Version 18 tools failed the restore (L-BAK1, below).

## 1. L-PG1: migrations, row-level security and the isolation suite on Postgres 16

**Status:** verified 2026-11-18 (44 passed on PostgreSQL 16.15, throwaway container). The exact command, the safety guard and the WSL note are in `LOCAL_CHECKS.md` L-PG1. Never point it at port 5432 or an existing server.

## 2. L-BAK1: backup and restore round trip on Postgres

**Status:** backup verified on Postgres 16; the restore has not passed (**unverified**). The working method, exact commands and the 2026-11-18 results are in `LOCAL_CHECKS.md` L-BAK1.

| Field      | Value                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | Docker; a throwaway Postgres 16 container on a non-default host port; client tools of the server's major version with GNU `sha256sum` (for example a `postgres:16-bookworm` container, as in `Dockerfile.backup`) |
| Commands   | Seed with `scripts/real-pg/seed.ts`, then run `backup.sh` and `restore.sh` with those tools (`LOCAL_CHECKS.md` L-BAK1)                                                                                            |
| Expected   | "versions ok", "checksum ok", and row counts equal to the source's                                                                                                                                                |
| Pass       | `restore.sh` exits 0 with matching counts                                                                                                                                                                         |
| Paste back | Both outputs (no passwords) and the source counts                                                                                                                                                                 |

In the Alpine image, `restore.sh` stops at `sha256sum --check` (BusyBox), so that image cannot finish the check.

## 3. L-KEY1: secret key rotation on Postgres

**Status:** re-sealing verified on PostgreSQL 16.15 (2026-11-18). A webhook delivery and a live own-account connection after rotation were not run.

| Field      | Value                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Needs      | A throwaway Postgres 16; two generated keys; for the remaining parts, a webhook receiver and a live own-account relayer (L-BYO1) |
| Commands   | `LOCAL_CHECKS.md` L-KEY1: seed, copy, `rotate-key.ts` dry run and `--apply`, `scripts/real-pg/check-keys.ts`                     |
| Expected   | Dry run counts, then `"committed":true`, then `[check-keys] PASS`                                                                |
| Pass       | All three                                                                                                                        |
| Paste back | The JSON lines (counts only)                                                                                                     |

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
