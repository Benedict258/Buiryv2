# Deploying the preview on Render

**Other targets.** One Oracle Cloud VM (Always Free): `docs/DEPLOY_ORACLE.md`, DESIGNED ONLY. AWS: `docs/DEPLOYMENT.md`. This Render plan remains an alternative.

Read-only plan for the tester preview (bring your own storage, BD36). **Nothing has been deployed.** Statements about Buiry come from the code and are tested on mocks and PGlite. Statements about Render quote Render's documentation (read 2026-11-22, URLs given). Anything about Render that those pages do not state is marked **UNVERIFIED**. "Must check on Render" at the end lists what the owner confirms before the first tester.

**Network.** The preview runs on the network `WALRUS_NETWORK` names, testnet or mainnet. Nothing defaults to one. A mainnet preview also needs `BUIRY_ALLOW_MAINNET=1`. Neither has been deployed on Render; mainnet live use is UNVERIFIED.

## 1. Services

One image (`Dockerfile`) runs every role. The roles come from `BUIRY_ROLE` (`packages/worker/src/main.ts`).

| Service             | Render type                   | Command                                                            | Notes                                                                                                                                                                                                                        |
| ------------------- | ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API, MCP, dashboard | Web service (Docker)          | image default: `node dist-server/server.js`, with `BUIRY_ROLE=api` | Serves REST `/v1`, MCP `/mcp` and the dashboard from `DASHBOARD_DIR`. Stateless: nothing is written to local disk (checked by searching the server packages for file writes), so the ephemeral filesystem is fine.           |
| Background jobs     | Background worker (Docker)    | same image, `BUIRY_ROLE=worker`                                    | Write drains (one per storage account), expiry scan, renewal (if on), webhooks, drift scan, snapshots, isolation canary, relayer probe. Database leases mean several instances run each job once per interval (`Scheduler`). |
| Database            | Render Postgres               | none                                                               | Buiry is tested on PostgreSQL 16 (L-PG1, L-BAK1) and runs on PGlite in tests. Render offers 13 to 18 (section 6).                                                                                                            |
| Migrations          | Pre-deploy command on the API | `node dist-server/migrate.js`                                      | Production servers refuse to start while migrations are pending (`buildRuntime`). Migrations hold a Postgres advisory lock (`PgDb.migrate`), so a second run waits rather than races.                                        |

Render's documentation on these service types:

- "Background workers are services that run continuously (like a web service or a private service), but they don't receive any incoming network traffic." (https://render.com/docs/background-workers)
- "If defined, the pre-deploy command runs _after_ your service's build finishes, but _before_ that build is deployed." Database migrations are listed as a use. "The pre-deploy command is available for paid web services, private services, and background workers." (https://render.com/docs/deploys)
- **Free instances:** there is no pre-deploy command. Set `BUIRY_MIGRATE_ON_START=1` on the API service only; the advisory lock still applies. Running migrations this way on Render is UNVERIFIED.

## 2. Health endpoint

- **Endpoint.** `GET /v1/healthz` returns 200 with `{"status":"ok"}` and, when the networks agree, the Sui network. The image's Docker `HEALTHCHECK` uses the same path.
- **Render health checks:**
  - "Web services can receive health checks as HTTP GET requests to a path you specify".
  - "Render considers a check successful if the instance responds with a `2xx` or `3xx` status code within five seconds."
  - On a new deploy: "If this condition is not met within 15 minutes, Render cancels the deploy and continues routing traffic to your service's existing instances."
  - Source: https://render.com/docs/health-checks.
- **Set the health check path to `/v1/healthz`.** A server that refuses to start never answers, so Render cancels that deploy. Refusals include configuration problems, pending migrations and a network mismatch.

## 3. Environment variables (names only)

Set them in the Render dashboard or an environment group. **Secret** marks a value that grants access; never paste one into chat, issues, reports or commits (`docs/LIVE_ENV.md`). "Environment groups are collections of environment variables and/or secret files that you can link to any number of different services." (https://render.com/docs/configure-environment-variables)

**Both services, required:**

- `NODE_ENV=production`
- `DATABASE_URL` (**secret**: it contains the password)
- `BUIRY_SECRET_KEY` (**secret**)
- `BUIRY_BASE_URL` (https)
- `BUIRY_ALLOWED_ORIGINS`
- `BUIRY_MAILER=smtp`, plus `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD` (**secret**), `SMTP_FROM`
- `BUIRY_ROLE` (`api` or `worker`)

**Preview configuration (Phase 9 C1):**

- `BUIRY_PREVIEW=1` and `BUIRY_MANAGED=off`.
- Leave unset: `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID`, `WALRUS_DELEGATE_KEY`, `BUIRY_MANAGED_WORKSPACE_ID` and `BUIRY_MANAGED_MULTI_TENANT`. Preview refuses to start with a managed workspace or multi-tenancy, in any environment.
- **Projects without their own account:** each tester connects their own Walrus account on the server's network. Until a project does, its writes are refused with a clear message.
- `WALRUS_NETWORK` (`testnet` or `mainnet`) is required in preview. The server refuses to start without it, or when it disagrees with `TATUM_NETWORK` or a relayer host.
- `BUIRY_ALLOW_MAINNET=1` only for a mainnet preview. Without it a mainnet server refuses to start, and testers' mainnet accounts are refused. Never set it on a testnet service.
- `WALRUS_RELAYER_NETWORK` only if some relayer host is not one Buiry recognises (`docs/LIVE_ENV.md`, Networks).

**Chain verification (optional):**

- `TATUM_API_KEY` (**secret**), `TATUM_NETWORK` (the same network as `WALRUS_NETWORK`; required with the key), `TATUM_GRPC_ENDPOINT` (required on testnet; on mainnet unset means `https://sui-mainnet-grpc.gateway.tatum.io`), `TATUM_FREE_RPS`.
- Without a key every chain check returns `unknown`, never a pass.
- **A key per network.** Tatum issues separate mainnet and testnet keys ("Use the key that matches the network you call", https://docs.tatum.io/reference/authentication). Use the mainnet key on a mainnet service.
- **Free-plan limits.** Tatum's pages disagree: https://docs.tatum.io/docs/plans-limits and https://tatum.io/pricing say 3 requests per second, the authentication page says 5; credits are given as 100,000 (pricing: "lifetime") and as 1,000,000 (read 2026-11-24). Check the owner's Tatum dashboard. One server-side key is shared by every tester, so a low requests-per-second limit can throttle chain checks when many testers work at once; throttled checks return `unknown`.
- **Later fallback, not built:** a direct Sui RPC connection instead of Tatum.

**Optional:**

- `BUIRY_RENEWAL=on` (off by default; testnet blobs last about 5 days; for mainnet see `docs/OPERATIONS.md`, Storage lifetime)
- `BUIRY_AGENT_TOKEN_MAX_DAYS` (default 90)
- `BUIRY_TRUSTED_PROXY_HOPS`
- `BUIRY_SSE_MAX_PER_USER`, `BUIRY_SSE_MAX_PER_PROJECT`
- `BUIRY_PACK_MAX_ITEMS`, `BUIRY_BYO_ADAPTER_CACHE`
- `BUIRY_REQUEST_LOG` (`off` silences request, write and job lines)
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (**secret**), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (**secret**) (each pair together)

**Image build:**

- `VITE_BUIRY_PREVIEW=1`, a Docker build argument, builds the preview dashboard: no billing page, plan chip or upgrade prompts.
- Whether Render passes environment variables to `docker build` as build arguments is UNVERIFIED.

**Set by the image:** `PORT=8787`, `DASHBOARD_DIR`, `BUIRY_PROTO_ROOT`. Whether Render sets its own `PORT` for Docker services is UNVERIFIED; the server listens on `PORT`.

**Never set in production:**

- `BUIRY_BYO_ALLOW_PRIVATE`: refused.
- `BUIRY_MAILER=console`: refused. The console mailer prints sign-in links, which carry a token.
- The live-check account names (`BYO_A_*`, `BYO_B_*`) and other test-only names in `.env.example`.

## 4. Before the first tester

1. **Migrations.** Run the migration (pre-deploy command, or the API's first start) and check that `GET /v1/healthz` returns 200.
2. **Token expiry migration, dry run (L-TOK1).** Run it against this database and send the owner the output. It prints counts by scope; no token, hash, name or id. Apply with `--apply` only after the owner's go-ahead. Command:

   ```sh
   DATABASE_URL=<this database> BUIRY_SEED_ALLOW_REMOTE=1 pnpm tsx scripts/real-pg/token-expiry.ts
   ```

   Until it runs, finding M4 stays partly fixed (`docs/SECURITY_REVIEW.md`).

3. **Startup log.** It must show no "refusing to start", and no "queued writes ... cannot be stored" line. On a new database there is nothing queued.
4. **Owner's own check.** The owner connects their own account on the server's network and writes one memory end to end (`docs/TESTER_ONBOARDING.md`), before inviting anyone. On mainnet this comes after a mainnet canary has passed (`docs/LIVE_PROOF.md`, pass criteria).

## 5. Logs

**Format.** Every line is either a `[buiry] ...` operator message or one JSON object per line. Each JSON line carries `level` and `event`.

| Event / line                       | From                             | Fields                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`                          | API, each request                | `requestId`, `method`, `route` (pattern, such as `/v1/projects/:id/memories`), `status`, `ms`, `project` (id from the path, when present), `error` (Buiry error code or error class, on 4xx and 5xx) |
| `write_queued`                     | API, each accepted write         | `project`, `evt` (such as `memory.created`), `actor` (`agent` or `user`)                                                                                                                             |
| `job`                              | worker, each job run             | `name`, `ok`, `ms`, `error` (class and code) on failure                                                                                                                                              |
| `write_job`                        | worker, each write status change | `at`, `job`, `memory`, `project`, `relayerJob` (the relayer job id), `status`, `attempt`, `reason` (fixed text) and `retryInSec` on a retry. No text, no namespace                                   |
| `[buiry] job <name> failed: {...}` | worker, each failed run          | Kept unchanged; the job-failure alarm matches it                                                                                                                                                     |
| `server_error`                     | API, unexpected 500              | `requestId`, `method`, `route`, `error` class, Postgres `code`, stack frames; never the message                                                                                                      |
| `renewal_error`                    | worker                           | class and code                                                                                                                                                                                       |
| `[buiry] ...` startup lines        | both                             | Configuration refusals name variables, never values. Network warnings give kind, status and cause code (A11). Stranded-write warnings give counts and project ids                                    |

**Questions the logs answer, without content:**

| Question                 | Field to group or sum                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Request counts           | `event=request`, by `route` and `status`                           |
| Latency                  | `ms` per `route`                                                   |
| Error classes            | `error` on `request`, `server_error` and `job` lines               |
| Job failures             | `event=job` with `ok=false`, or the `[buiry] job ... failed` lines |
| Per-project write volume | `event=write_queued`, by `project`                                 |

`write_queued` is logged when the write is accepted inside its transaction, so a transaction that later rolls back still leaves a line; counts can run slightly high. MCP requests all share the route `/mcp`; their writes are counted by `write_queued`.

**Log hygiene: no memory content, tokens or secrets.** How it was checked:

1. **Every log call in the server packages was read.** Search: `grep -rn "console\.\(log\|warn\|error\|info\)" packages/api/src packages/worker/src packages/storage/src packages/chain/src`. Each call prints one of:
   - fixed text;
   - variable names;
   - counts and ids;
   - error class and code (`errorTag`, `describeJobError`, `RelayerError.describe()`);
   - structured fields from the table above.

   The one call that prints a secret is the development console mailer's sign-in link. Production refuses that mailer (`productionProblems`), and preview runs with `NODE_ENV=production`.

2. **Tests that send content and secrets through and check the output:**

   | Test                                          | What it checks                                                                                                        |
   | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
   | `packages/api/test/observability.test.ts`     | Memory text, the session token and a query string stay out of request and write lines                                 |
   | `packages/api/test/byo-storage.test.ts`       | A relayer error body carrying a URL, a token and a key stays out of the A11 warning; the delegate key is never logged |
   | `packages/worker/test/migrate-errors.test.ts` | The database user, password and host stay out of the A9 migration log                                                 |
   | `server-errors.test.ts`                       | 500s log no message                                                                                                   |
   | Error-text sweep A1 to A13                    | `docs/SECURITY_REVIEW.md`                                                                                             |

3. **Not checked:** what Render itself adds to or keeps from these logs (retention, access) is UNVERIFIED.

## 6. Postgres on Render

- **Versions.** "Major versions 13 through 18 are available for all new instances." The default is "the latest supported version (18)." (https://render.com/docs/postgresql-creating-connecting)
  - Buiry is verified on 16 (L-PG1, 44 tests; L-BAK1 round trip). Choose 16, or run the L-PG1 suite against 18 before using it; 18 is UNVERIFIED for Buiry.
- **Backups.** "Render continually backs up paid Render Postgres databases to provide point-in-time recovery (PITR)."
  - Recovery window: "Hobby | Past 3 days", "Pro or higher | Past 7 days".
  - "Render does not provide recovery capabilities for databases on the Free compute plan." (https://render.com/docs/postgresql-backups)
- **Free plan.** "Free Render Postgres databases expire 30 days after creation." After a 14-day grace period Render deletes the database. Free databases "don't support any form of backups". (https://render.com/docs/free)
- **Recommendation.** Do not use the free database for testers: it expires and cannot be recovered. That would lose statuses, confirmations, evidence and the renewal source. Re-indexing from Walrus is not built.

## 7. Free web services

"Render spins down a Free web service that goes 15 minutes without receiving any inbound traffic." (https://render.com/docs/free)

- **Free API service.** The first request after idle waits for a cold start. Whether an MCP client tolerates that wait is UNVERIFIED.
- **Free worker.** A background worker on a free plan is not described on the pages read: UNVERIFIED.

## 8. Must check on Render (owner)

1. Postgres version offered to your workspace. 16 is what Buiry is verified on (section 6).
2. A paid Postgres plan for testers, its point-in-time recovery window, and that logical exports work (section 6).
3. Background worker support on the plan you choose, and the pre-deploy command on the API service (paid only, section 1).
4. Health check path `/v1/healthz` set on the API service.
5. Whether environment variables reach `docker build` as build arguments, for `VITE_BUIRY_PREVIEW=1`. If not, build the image elsewhere or set the argument in a Render build setting.
6. Whether Render sets `PORT` for Docker web services, and how many proxy hops sit in front (for `BUIRY_TRUSTED_PROXY_HOPS`).
7. Log retention and who can read service logs.
8. Outbound access from Render to the relayer of the chosen network and, if used, Tatum.
