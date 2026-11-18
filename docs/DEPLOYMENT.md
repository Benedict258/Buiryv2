# Deploying Buiry on AWS

Prepared offline. Nothing here has been applied or deployed. The image layout and the Terraform were checked locally (see "What was verified"); the first real build, apply and deploy are the owner's steps (LOCAL_CHECKS L-AWS1 to L-AWS3).

## Shape

| Piece                | AWS service                                                                                                   | Notes                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API and MCP endpoint | ECS Fargate service `api` (`BUIRY_ROLE=api`) behind an Application Load Balancer                              | Two tasks in private subnets; health check `GET /v1/healthz`; the dashboard is served by the same container                                                         |
| Background jobs      | ECS Fargate service `worker` (`BUIRY_ROLE=worker`)                                                            | Write drains (one per storage account), expiry scan, renewal (if on), drift scan, webhooks, snapshots, isolation canary. Job leases make more than one worker safe. |
| Migrations           | ECS task definition `migrate` (`node dist-server/migrate.js`)                                                 | Run once per deploy, before the services roll. Servers refuse to start while migrations are pending; migrations hold a Postgres advisory lock.                      |
| Database             | RDS Postgres (`rds.force_ssl=1`, encrypted, Multi-AZ, automated backups, deletion protection, final snapshot) | Master password managed by RDS in Secrets Manager                                                                                                                   |
| Secrets              | Secrets Manager, injected as environment variables                                                            | Values are set out of band, never in Terraform or files; see `docs/KEY_CUSTODY.md`                                                                                  |
| TLS                  | ACM certificate on the ALB (TLS 1.2+ policy), HTTP redirects to HTTPS                                         | DNS validation records are a Terraform output                                                                                                                       |
| Logs and alarms      | CloudWatch log groups per role; alarms to an SNS topic                                                        | ALB 5xx, unhealthy targets, RDS CPU and free storage, worker not running, job failures                                                                              |

Every response carries security headers, including an enforced Content Security Policy and `frame-ancestors 'none'`; HSTS is added when the ALB reports https (`BUIRY_TRUSTED_PROXY_HOPS=1`, `X-Forwarded-Proto`). `BUIRY_CSP=report-only` is a fallback if a screen breaks (`docs/SECURITY_REVIEW.md`, "Security headers").

Rate limits key on the client address. Behind the ALB the task definition sets `BUIRY_TRUSTED_PROXY_HOPS=1`, so the server uses the address the ALB appended to `X-Forwarded-For` and ignores anything the client wrote there. Without a proxy leave it at 0. The server keeps idle connections for 65 s, longer than the ALB's 60 s idle timeout, so the load balancer never reuses a socket the server has just closed.

## Files

- `Dockerfile`, `.dockerignore`: two-stage build. The build stage runs `pnpm install`, builds the dashboard and the server bundle (`packages/worker/tsup.server.config.ts`: workspace code inlined, third-party packages external), and installs production dependencies with `pnpm deploy --prod` (hoisted). The runtime stage runs as `node` with `NODE_ENV=production`, `BUIRY_PROTO_ROOT=/app/proto` and `DASHBOARD_DIR=/app/dashboard`.
- `infra/aws/` (Terraform, AWS provider `~> 5.0`; lock file pins 5.100.0): network, ALB, ECS, RDS, Secrets Manager, CloudWatch. Choices left to the owner are variables without defaults: `region`, `domain_name`, `image` (pin by digest), `sui_network`, `db_instance_class`.
- `.env.production.example`: every setting by name. The server refuses to start in production when a required value is missing or weak (`packages/api/src/config-check.ts`).
- `scripts/smoke-deploy.ts`: post-deploy checks without credentials.

## Deploy steps (owner)

1. Choose the region, domain, Sui network and RDS instance class. Prices are not stated here; read them on the AWS pricing pages for the chosen region.
2. Build and push the image to ECR. Note its digest.
3. `cd infra/aws && terraform init` with a remote state backend of your choice (S3 with locking), then `terraform plan` with a `*.tfvars` file (gitignored). Review, then apply.
4. Create the ACM validation DNS records (output `acm_validation_records`) and point the domain at `alb_dns_name`.
5. Set every secret value in Secrets Manager (names in `secret_names`). Build `DATABASE_URL` from the RDS-managed master secret with `sslmode=require`; a separate least-privilege database user is a follow-up.
6. Run the `migrate` task once (`aws ecs run-task` with the private subnets and the app security group). Check its log says the database is up to date.
7. Scale the `api` and `worker` services to their desired counts, or let the apply do it.
8. Run `pnpm tsx scripts/smoke-deploy.ts https://<domain> --network <testnet|mainnet>`. Then sign in, create a project, connect an agent and check that a memory reaches the Storage page as stored.

**Naming the managed tenant (BD42).** Production refuses to start unless it either names the workspace that owns the shared Walrus account (`BUIRY_MANAGED_WORKSPACE_ID`) or switches managed storage off (`BUIRY_MANAGED=off`). It also refuses `BUIRY_MANAGED_MULTI_TENANT=1`. A workspace id exists only after the first sign-in, so the first deploy runs with managed storage off:

1. Apply with `managed_workspace_id` empty (the default). The task definitions get `BUIRY_MANAGED=off`. The `WALRUS_*` secrets can already hold their values; they are not used while managed storage is off.
2. Sign in. Your workspace id is in the dashboard URL (`/w/wsp_.../projects`) and in `GET /v1/auth/me`. Do not create a project yet: with managed storage off it could only bring its own account.
3. Set `managed_workspace_id` to that id in your `*.tfvars`, apply again, and let the services roll. Managed storage then serves only that workspace.

For later deploys: build and push, run `migrate`, then update the services with the new image digest. The deployment circuit breaker rolls back a failing service.

## Backups and restore

Requirements are in `docs/OPERATIONS.md` (the database maps memories to Walrus blobs and holds sealed secrets; it must be backed up, and `BUIRY_SECRET_KEY` must be kept separately).

- **Automated backups:** RDS point-in-time recovery within `db_backup_retention_days` (default 14, the owner's choice). Snapshots are kept on delete (final snapshot, deletion protection on).
- **Logical copy:** `infra/aws/backup.tf` provisions a KMS-encrypted, versioned, private bucket with a lifecycle rule, and a daily EventBridge schedule that runs `scripts/backup/backup.sh` from `Dockerfile.backup`. Set `backup_image` to enable the schedule. For off-site protection, move the bucket to another account or region. Restore: `docs/OPERATIONS.md`, "Recovering from a dump".
- **Restore drill**, on a schedule the owner sets:
  1. Restore to a new instance: point-in-time, or from a snapshot.
  2. Run the migration task against it.
  3. Start a server with that `DATABASE_URL` and the same `BUIRY_SECRET_KEY`.
  4. Run `buiry doctor` and `buiry evidence` for a known project, and check that one known blob id still lists on the relayer.
- **What a restore cannot bring back:** writes made after the restore point. Memories stored on Walrus after that point exist on Walrus but are unknown to the restored database. Re-indexing them from the relayer's listing is not built.

## Alarms

| Alarm                       | Meaning                                          | First response                                                                    |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `alb-5xx`                   | More than 10 server errors in 5 minutes, twice   | Check the api log group; recent deploy?                                           |
| `unhealthy-targets`         | An API task fails `/v1/healthz`                  | Task log: refused to start (configuration, pending migrations, network mismatch)? |
| `db-cpu`, `db-free-storage` | Database under pressure or filling               | Storage autoscaling is on up to `db_max_allocated_storage_gb`                     |
| `worker-running`            | No worker task running                           | Writes queue up and nothing reaches Walrus; check the worker log                  |
| `job-failures`              | More than 5 failed background jobs in 15 minutes | Worker log lines `[buiry] job <name> failed`                                      |

Walrus relayer and Tatum health are visible on the Storage and Verification pages. A relayer-down alarm built from the `relayer_status` table is a follow-up.

## What was verified (2026-11-17, without AWS or Docker)

- The server bundle and a hoisted production install (`pnpm deploy`) were assembled in a temporary directory outside the repository, like the image. From that layout:
  - Production with a weak configuration refuses to start and lists the problems.
  - Production with a valid configuration and an unreachable database reports the connection error.
  - The migration entry without `DATABASE_URL` exits with code 2.
  - Development mode serves `/v1/healthz` and the dashboard.
  - With Tatum configured, the server starts with the protos from `BUIRY_PROTO_ROOT`.
- `scripts/smoke-deploy.ts` passed every check against that local server except HTTPS (it ran on plain `http://localhost`).
- `terraform init -backend=false && terraform validate`: "Success! The configuration is valid." No credentials were used.
- Not verified: `docker build`, a run against real Postgres, `terraform plan` or apply, anything on AWS (LOCAL_CHECKS L-AWS1 to L-AWS3).
