# Buiry v2: Handoff

This file lets a new session resume the project cold. Facts come from the repo docs, the code, and live-check reports recorded in `LOCAL_CHECKS.md`. Anything not confirmed is marked "unverified". Re-check against the repo before relying on it.

## 1. What this is

Buiry is a portable, verifiable project-memory layer for AI coding agents. Agents connect over MCP, read a briefing for the task, write typed memories with evidence, report whether a memory helped, and hand off between sessions and tools. Memory is stored on Walrus Memory, scored by a deterministic learning loop, checked against the chain through Tatum's Sui gateway, and governed from a dashboard.

The idea: memory belongs to the project, not the tool. Switch from one agent to another and the project's knowledge, including past failures and stale facts, comes with it.

### Current goal

Finish a working, production-grade prototype for ourselves. It was first built for the Tatum x Walrus "Total Recall" hackathon. That goal is dropped. A later aim is the Microsoft Imagine Cup and possibly moving parts to Azure; deliberately deferred until the prototype works. Do not start it yet.

### Decisions already made (by the owner)

- Keep Walrus Memory as the storage layer.
- Tatum: undecided. Keep it for now behind the gateway (`packages/chain/src/tatum.ts` plus `packages/chain/src/tatum/`). Do not remove it, do not expand it. Revisit after the prototype works. See section 9.
- Imagine Cup and Azure: after the prototype.

## 2. Source of truth

For what the product does or was verified to do: code and tests, then `LOCAL_CHECKS.md`, `docs/EVIDENCE.md`, `docs/BEHAVIOUR.md` and `docs/LOAD.md`, then `docs/ASSUMPTIONS.md` and `docs/DECISIONS.md`, then `docs/PROGRESS.md` and `docs/SECURITY_REVIEW.md`, then this file. `docs/01-whitepaper.md`, `02-prd.md`, `03-architecture.md` and `04-ui-spec.md` are design intent; each now opens with a status note listing statements later records superseded. Within design intent, the architecture wins, then the PRD. `CLAUDE.md` holds the non-negotiable rules.

Registers and counts (from the files, 2026-11-18):

- `docs/DECISIONS.md`: BD1 to BD41.
- `docs/ASSUMPTIONS.md`: A1 to A29 (A7 withdrawn; A18 and A19 were reconstructed after being cited).
- Migrations: 001 to 009 (`packages/api/src/db/migrations.ts`).
- REST routes: 97 registered. 72 need a signed-in user, 9 are public (health, auth, the showcase), and 16 are agent operations under `/v1/agent/*` registered from one table (`packages/api/src/http/routes-*.ts`).
- Other docs: `BEHAVIOUR.md`, `EVIDENCE.md`, `LOAD.md`, `SECURITY_REVIEW.md`, `OPERATIONS.md`, `KEY_CUSTODY.md`, `DEPLOYMENT.md`, `ARCHITECT_BRIEFING.md`, `BLOG_OUTLINE.md`, `diagrams/architecture.mmd`, `design/` (the design report), plus `LOCAL_CHECKS.md`, `README.md`, `release.json` and `Development.md` (change history) at the root.

## 3. Architecture at a glance

pnpm monorepo, TypeScript (strict, ESM), Node 20 or newer (`engines`). CI runs Node 20; the local gate runs on Node 24.16 (Windows).

| Path               | What it does                                                                                                                                                                                                                                                     | Licence                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `packages/core`    | Pure logic, no I/O: memory header codec, namespaces, idempotency keys, redaction, prompt-injection scanner, learning loop, briefing builder, `BUIRY.md`, tool protocol types                                                                                     | Apache-2.0                 |
| `packages/storage` | The only place that talks to Walrus: signed relayer client, Seal session, mock relayer, durable write queue (in-memory and Postgres), write worker, recall merge, expiry reconcile                                                                               | proprietary (`UNLICENSED`) |
| `packages/chain`   | The only place that talks to Tatum: gateway `src/tatum.ts`, transports in `src/tatum/` (gRPC; JSON-RPC only when `TATUM_JSONRPC_URL` is set), mock Tatum server, vendored Sui protos, verifiers                                                                  | proprietary (`UNLICENSED`) |
| `packages/mcp`     | MCP server: 13 tools, 3 resources, 2 prompts; stdio and Streamable HTTP; REST client backend. Workspace name `@buiry/mcp`; published name `@buiry/mcp-server` (`release.json`, BD39; not published); binary `buiry-mcp`                                          | Apache-2.0                 |
| `packages/api`     | Postgres schema (migrations 001 to 009) with row-level security, memory service, auth (sessions, wallet, OAuth, email link, SMTP mailer), 97 REST routes, SSE live feed, webhooks, packs, branches and merge, renewal, public showcase, dashboard static serving | proprietary (`UNLICENSED`) |
| `packages/worker`  | Server entry (`buiry-server`), migrate and rotate-key entries, and jobs: write-drain (one per storage account), relayer-probe, expiry-scan (queues renewals when `BUIRY_RENEWAL=on`), webhooks, drift-scan, snapshot, isolation-canary                           | proprietary (`UNLICENSED`) |
| `packages/cli`     | `buiry`: login, init, connect, status, doctor, briefing, remember, recall, verify, export, import, branch, sync, evidence                                                                                                                                        | Apache-2.0                 |
| `apps/dashboard`   | Vite, React and TypeScript SPA built from the UI spec; hand-written CSS from tokens (BD23)                                                                                                                                                                       | proprietary (`UNLICENSED`) |
| `scripts`          | conformance (30 checks), demo (mock and `--live`), dev-server, dashboard-shots, chain-smoke, db-smoke, tatum-latency, renewal-live, byo-live, smoke-deploy, with-env, write-demo-memories, `behaviour/`, `load/`, `backup/`, `release/`                          | proprietary                |

npm names: workspace packages are `@buiry/core`, `@buiry/mcp` and `@buiry/cli` at version 0.0.0. The release script publishes them as `@buiry/core`, `@buiry/mcp-server` and `@buiry/cli` at 0.1.0 (`release.json`). Nothing is published (L-P1 checked tarballs locally). `@buiry/mcp` on npm is the v1 package (BD39).

Root `LICENSE` is a short per-package notice (BD1). It has not had a legal review.

Other infrastructure files: `Dockerfile`, `Dockerfile.backup`, `infra/aws/` (Terraform, validated offline, never applied), `.env.example`, `.env.production.example`.

### Confinement rules (enforced by ESLint `no-restricted-imports` and `packages/chain/test/confinement.test.ts`)

- Walrus access only in `packages/storage`.
- Chain and Tatum access only in `packages/chain/src/tatum.ts` and `packages/chain/src/tatum/`; only the gateway reads `TATUM_API_KEY`.
- Namespaces are derived server-side only: `buiry.v1.<project_id>.<branch_slug>`.
- Memory text is untrusted data whenever it reaches an agent.

### Key design points

- **Event-sourced memory.** Tier A events are durable (written to Walrus); tier B events are local. Each stored record has a header line, a body, and evidence lines.
- **Two idempotency layers (BD13).** A request-level key and a storage-level key; retries suffix the relayer key with `.a<n>`.
- **Learning loop** (`packages/core/src/learning.ts`, architecture section 9). Agent memories start at confidence 0.35; verified evidence raises it (cap 0.9); helpful reports raise it, at most two increments per memory per day (agent 0.5, person 1.0); per-type half-life decay at read time; auto-promotion counts only other sessions' reports (BD9); an agent never confirms its own memory (BD11); per-project overrides (BD27).
- **Drift.** A package upgrade turns a cited deployment memory stale, raises a flag, and shows it to the next agent in `buiry_check`.
- **Tenant isolation, three layers (BD18):** token or session fixes the tenant; scoped lookups answer `not_found` for foreign ids; Postgres row-level security under an unprivileged role. `packages/api/test/isolation.test.ts` walks the route registry and every MCP tool. On storage: the shared managed account serves one workspace (BD41); other workspaces bring their own account (BD36).
- **Auth.** Opaque session tokens (HttpOnly cookie, Origin check on cookie writes; bearer also accepted), agent tokens (expire after `BUIRY_AGENT_TOKEN_MAX_DAYS`, BD40), API tokens, all stored as keyed hashes; wallet challenge; OAuth adapters (GitHub, Google); email link (console mailer in development, SMTP in production, BD38).
- **Write path.** Durable lease-based queue with backoff, dead-lettering, reconciliation of uncertain submits, admission budgets and backpressure.
- **Renewal by rewrite (BD37).** Behind `BUIRY_RENEWAL=on`, off by default: the exact stored text is written again as a new blob; the memory switches once it is stored.
- **Briefings.** Token-budgeted with a fixed untrusted-data preamble; the dashboard can show each item's score breakdown; agents never receive scores (BD29).
- **Public showcase (BD31).** Opt-in per project; confirmed memories only; no agent names, activity or tokens.

## 4. State of the build

### Gate

At `b480535` (2026-11-18): typecheck (root and dashboard), ESLint, Prettier and vitest pass, with 487 tests in 53 files. Conformance 30/30 (run on `eb82230`, `docs/PROGRESS.md` "Final checks"). Coverage was last measured at 461 tests: statements 88.35%, lines 90.95% (`docs/PROGRESS.md`); not re-measured since. `pnpm audit --prod` was last recorded as 0 advisories on 2026-11-16; it has not been re-run since.

### Verified live (every line cites its record; the network is named)

| Result                                                                                                        | Network                           | Record                                      |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------- |
| Relayer unsigned endpoints (`/health`, `/version`, `/config`)                                                 | Mainnet relayer, testnet relayer  | LOCAL_CHECKS L-W1 (unsigned), L-W0T         |
| Signed remember, bulk, restore, Memory Read listing; recall with a Seal session                               | Mainnet (2026-11-10)              | L-W1 (signed), L-W2                         |
| Signed Walrus calls with the testnet account; REAL contract suite 4 of 4; recall with text, not degraded      | testnet (2026-11-11)              | L-W1T, L-W2T                                |
| Tatum Sui gRPC: service info, object, package versions, transaction                                           | Mainnet; testnet                  | L-T0, L-T2; L-T4                            |
| Tatum latency: about 0.3 s per call once connected; 10 of 50 attempts retried in each run                     | testnet (2026-11-16)              | L-T5, HANDOFF s9                            |
| Demo package published and upgraded                                                                           | testnet                           | L-D0                                        |
| Two-agent live demo, fresh-package run: every stage passed                                                    | testnet (2026-11-16)              | L-D1, `docs/EVIDENCE.md`                    |
| Renewal by rewrite: one memory renewed to a new blob                                                          | testnet (2026-11-17)              | L-R1                                        |
| Agent behaviour: Claude Code 2.1.326 10 of 10 (one run per behaviour); OpenCode 2.2.5 2 of 2                  | testnet                           | L-B1, `docs/BEHAVIOUR.md`                   |
| Earlier behaviour check: Claude Code 2.1.312, 3 of 3 called connect and check first and handoff last          | local server (pointer file path)  | L-M1 (partial; the id is reused, see below) |
| Dashboard walkthrough: 21 of 21 steps, including invitations, permissions and a second user                   | testnet (2026-11-18)              | L-UI1                                       |
| Light load: 6 of 6 stored in 204 s; briefing p50 63 ms; recall p50 1.9 s, max 18 s (n=5)                      | testnet (2026-11-18)              | L-LOAD2, `docs/LOAD.md`                     |
| Migrations 001 to 005 and row-level security on real Postgres (`embedded-postgres`)                           | local real Postgres               | L-A3                                        |
| Server on real Postgres with Tatum gRPC: health 200, `/mcp` without a token 401, dashboard served             | local real Postgres; Mainnet gRPC | L-A4                                        |
| Email-link sign-in, cookie, reload and cross-origin 403 against a real server                                 | local real Postgres               | L-U2 (partial)                              |
| Showcase on and off in a fresh browser context                                                                | local                             | L-U3 (partial)                              |
| MCP client config shapes: Claude Code 2.1.312 saw 13 tools; OpenCode 1.19.5 connected; Codex 0.165.0 parsed   | local                             | L-M2 (partial)                              |
| Wallet signature from `@mysten/sui` 2.38.0 verifies; wrong key and replayed nonce rejected; no browser wallet | local                             | L-A2 (partial)                              |
| Clean install from packed tarballs (help, version, doctor)                                                    | local, no registry                | L-P1                                        |

`LOCAL_CHECKS.md` uses the id L-M1 twice: the SMTP check (waiting for the owner) and the earlier Claude Code behaviour check (partial).

### Verified on mocks only

Everything in section 3 is tested on stand-ins: MockRelayer (`packages/storage/src/mock-relayer.ts`), the mock Tatum server (`packages/chain/src/tatum/mock-server.ts`), PGlite (in-process Postgres), a fake SMTP server, and stub `pg_dump`, `pg_restore`, `psql` and `aws` tools for the backup scripts. The dashboard screen pass (L-U1, 94 screenshots) runs on the mock-backed development server with sample data (BD28).

### Not verified

- Migrations 006 to 009 on real Postgres (only PGlite), and the isolation suite on real Postgres.
- Backup and restore round trip on Postgres and S3 (L-BAK1); secret key rotation on Postgres (L-KEY1).
- Concurrent agents against Postgres; several API tasks behind a load balancer; relayer limits under sustained load (A6).
- Any Docker build, Terraform plan or apply, or AWS deployment (L-AWS1 to L-AWS3).
- Bring-your-own Walrus account against a real second account (L-BYO1).
- A real SMTP sign-in email (L-M1, SMTP).
- OAuth sign-in with real GitHub or Google apps (L-A1, A21).
- Cursor (not run). Codex behaviour (Codex is not installed here; only its config shape was parsed).
- Tatum credit usage and plan limits (A9, A18, A19); Tatum State, TransactionExecution and Name services.
- The live demo on Mainnet; operator renewal (A1); relayer connect timeouts (A24) and one SDK 404 (A25); `expires_at` accuracy (A29).
- The EVM verifier against a real endpoint; a browser wallet.
- Re-indexing from Walrus after database loss (not built; `docs/OPERATIONS.md`).

### Assumptions that live checks proved wrong (fixed, with tests)

- **A13, request signing:** headers are `x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, `x-account-id`; `x-delegate-key` is never sent. Signatures were accepted live (L-W1).
- **A14, relayer paths and shapes:** routes are `/api/*` and `/v1/owners/{owner}/memories`; job state is `status`; recall returns `distance`.
- **A4:** restore returns counts only, never memory text.
- **A8, JSON-RPC:** Tatum's documented Sui JSON-RPC hosts returned 404; gRPC is the only working Sui transport.
- **A23:** recall needs a Seal session.
- **A27:** `.env` said testnet while the relayer served Mainnet; the server now refuses mixed networks (BD33).
- **Chain id:** gRPC returns the base58 chain digest. **Custom Tatum gateway host:** served neither transport.

The bugs found only by live runs are listed in `Development.md`.

## 5. Blockers that need a human (in order)

1. **Rotate the keys that were pasted into chat**: the Tatum API key now (new key in the Tatum dashboard, update `.env.testnet` and `.env`, revoke the old one). Rotate the Walrus delegates later, following `docs/KEY_CUSTODY.md`.
2. **Local Postgres checks**: L-BAK1 (dump and restore round trip) and L-KEY1 (secret key rotation on Postgres). Exact commands are in `LOCAL_CHECKS.md`; they need Docker or Postgres 16 tools.
3. **Second testnet Walrus account** for L-BYO1: put `WALRUS_BYO_TEST_RELAYER_URL`, `WALRUS_BYO_TEST_ACCOUNT_ID` and `WALRUS_BYO_TEST_DELEGATE_KEY` in `.env.testnet`, then run `scripts/byo-live.ts`.
4. **SMTP account** for one live sign-in email (L-M1).
5. **Container images** (L-AWS1): `docker build` of `Dockerfile` and `Dockerfile.backup`, a run against Postgres, then pin both by digest.
6. **AWS choices and plan** (L-AWS2): region, domain, RDS instance class, backup retention and the backup bucket's account or region. Check prices on AWS. Run `terraform plan` and review it.
7. **Apply and deploy** (L-AWS3):
   - set every secret in Secrets Manager;
   - first apply with `managed_workspace_id` empty (managed storage off), sign in, then apply again with your workspace id (BD42, `docs/DEPLOYMENT.md`);
   - run the migration task, scale the services;
   - run `scripts/smoke-deploy.ts` and check that rate limits behave behind the ALB (`BUIRY_TRUSTED_PROXY_HOPS=1`).
8. **npm names** in `release.json` (BD39), a legal re-read of the root `LICENSE` notice, then publish with your npm account.
9. **Tatum keep-or-move decision** (section 9): read the dashboard credit usage against the recorded call counts (A9).
10. **Before public exposure**: decide on the "still open" items in `docs/SECURITY_REVIEW.md` (shared rate-limit store, API token default expiry, least-privilege DB user).
11. **OAuth apps** for GitHub and Google, if wanted.
12. **Backup tag**: delete the local tag `backup-before-author-rewrite` once the rewritten history is confirmed (section 7).
13. **Mainnet cutover** (section 10), last.

## 6. Setup and commands

Requires Node 20 or newer and pnpm 10.28.0 (`packageManager`). On Windows, `npm i -g pnpm@10.28.0` if corepack needs admin rights. `corepack pnpm <cmd>` works without enabling shims. `pnpm typecheck` no longer calls pnpm internally; `pnpm build` and `pnpm dev:dashboard` still do, so those need `pnpm` on PATH.

- `pnpm install`
- `pnpm typecheck && pnpm lint && pnpm test`
- `pnpm test:cov`, `pnpm conformance`, `pnpm demo` (mocks), `pnpm demo --live`
- Dashboard on mocks: `pnpm --filter @buiry/dashboard build`, then `pnpm dev:api`. It prints a workspace id, a project id and a session token. The dev server serves `apps/dashboard/dist` by default when it is built (`DASHBOARD_DIR` overrides), so it works the same on Windows shells.
- Server: `pnpm tsx packages/worker/src/bin.ts` (REST on `/v1`, MCP on `/mcp`).
- CLI from source: `pnpm tsx packages/cli/src/bin.ts <command>`.
- Screenshot pass: `pnpm dashboard:shots <token> <workspace-id> <project-id>` (`CHROMIUM_PATH` overrides the browser).
- Chain smoke: `pnpm tsx scripts/chain-smoke.ts`. Database smoke: `pnpm tsx scripts/db-smoke.ts`.
- Write demo memories: `pnpm tsx scripts/write-demo-memories.ts --valid-until <date>`.

Windows notes: `.gitattributes` forces LF (`* text=auto eol=lf`); inline `VAR=value command` does not work in cmd or PowerShell; the credentials-file 0600 check is not a skipped test but a conditional assertion inside one test, so on Windows the test passes without checking the mode.

### Environment profiles

Live runs use an explicit profile: `pnpm tsx scripts/with-env.ts testnet -- <command>` loads only the gitignored `.env.testnet` (a names-only template with the public testnet values in comments is in place). No fallback to `.env`. See LOCAL_CHECKS "Profiles".

### Environment variable names (values only in the gitignored env files)

`.env.example` lists every name below (names only, grouped, with a comment where the meaning is not obvious). The unused `REDIS_URL` was removed.

Read by the code (from a grep of `packages`, `scripts`, `apps`):

- Walrus: `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID`, `WALRUS_DELEGATE_KEY` (private), `WALRUS_NETWORK`.
- Tatum: `TATUM_API_KEY`, `TATUM_NETWORK`, `TATUM_GRPC_ENDPOINT`, `TATUM_JSONRPC_URL`, `TATUM_FREE_RPS`.
- Server: `DATABASE_URL`, `BUIRY_SECRET_KEY`, `BUIRY_BASE_URL`, `BUIRY_ALLOWED_ORIGINS`, `BUIRY_MAILER`, `BUIRY_ENTITLEMENTS`, `DASHBOARD_DIR`, `PORT`, `NODE_ENV`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- CLI and MCP client: `BUIRY_API_URL`, `BUIRY_TOKEN`, `BUIRY_MCP_COMMAND`. Dashboard dev proxy: `BUIRY_API`.
- Scripts and tests: `DEMO_PACKAGE_ID`, `DEMO_TX_DIGEST`, `DEMO_NETWORK`, `VALID_UNTIL`, `BUIRY_CONTRACT_RELAYER_URL`, `SMOKE_TX`, `SMOKE_OBJECT`, `SMOKE_PACKAGE`, `CHROMIUM_PATH`, `DASHBOARD_URL`.

`WALRUS_DELEGATE_PUBLIC_KEY` is not read by any code or named in any doc; it may exist only in a local `.env` (unverified).

## 7. Rules and lessons

- No AI attribution in commits, PRs or files. Small, focused commits. No commit names an AI as author or committer. The 15 commits from `519db4d` to `d7d2f7f` were originally authored and committed as an AI identity; with the owner's approval their author and committer were rewritten to `ISAAC BENEDICT`, with trees, messages and dates unchanged, and `main` was force-pushed with a lease. Every hash from `519db4d` on changed, so old hashes in chat logs or notes no longer resolve. The pre-rewrite history is kept only in the local tag `backup-before-author-rewrite`, which was not pushed. Commits use the repo-local identity `ISAAC BENEDICT`.
- Never commit secrets. Gitleaks runs in CI (`.github/workflows/ci.yml`). Scan staged diffs and the commit range before any push. Never echo key values into logs, docs or commit messages.
- Do not invent facts about Walrus or Tatum. Unconfirmed things go behind an interface, get mocked, and are logged in `docs/ASSUMPTIONS.md` with source, how to verify, and what changes if false.
- Never fake a live result. Every real-network check is recorded in `LOCAL_CHECKS.md` with the exact command and what to paste back.
- Mocks hid real bugs. A live run is the only proof of live behaviour.
- Do not chain `lint` after `commit` with `;`; gate first, then commit.
- After each step: typecheck, lint, test, commit, update PROGRESS.md and LOCAL_CHECKS.md.
- Keep chat output concise; detail belongs in docs.
- CLAUDE.md rule 4 (no timelines or schedules in files) stays, by the owner's decision. The event dates in the PRD and the "close to the deadline" wording (L-D2, architecture section 14) were removed; L-D2 now says to run it when storage leases need to cover a date you choose. Dates that record when a check ran are records, not schedules, and stay.

## 8. Production gaps

- **Storage lifetime.** Walrus storage lapses (testnet about 5 days, Mainnet about 210 days as observed). Renewal by rewrite exists behind `BUIRY_RENEWAL=on`, off by default (BD37, L-R1 on testnet). Operator extension of blobs is unconfirmed (A1).
- **The database is a single point of loss.** Re-indexing from Walrus is not built; without a dump, statuses, evidence and the renewal source are lost (`docs/OPERATIONS.md`). Backup scripts exist; the Postgres round trip (L-BAK1) has not run.
- **Shared managed account.** Single-tenant (BD41). In managed mode the relayer sees plaintext, and one delegate's Seal session reaches every namespace on the account (A26). Production should set `BUIRY_MANAGED_WORKSPACE_ID`.
- **Relayer limits.** Documented public relayer limits (architecture section 6) mean multi-tenant managed use needs a self-hosted relayer, which is not built (self-hosted mode is refused).
- **Chain transport.** gRPC only; the gateway is built for one network (`TATUM_NETWORK`).
- **Hosting.** AWS files are prepared and validated offline; nothing is built or applied (`docs/DEPLOYMENT.md`).
- **Security items still open** (`docs/SECURITY_REVIEW.md`): per-process limits, API token default expiry, no least-privilege database user, dev-only advisories, and the two sweeps added after Phase A.
- **Legal and distribution:** licence notice re-read, npm names and publishing, privacy and data-deletion promises.
- **Billing and plan limits** are placeholders (BD21).
- **Placeholders (BD26):** bulk move-to-branch and flag notes, billing payment methods, browser wallet connect, the internal admin console. The marketing site is not built at all (no route in `apps/dashboard`).
- **Do not claim publicly:** a general Claude Code behaviour rate, live Walrus write performance, a working JSON-RPC fallback, anything about Mainnet beyond the 2026-11-10 checks, or bring-your-own accounts as live-tested.

## 9. Tatum: keep or move

Facts: Tatum's Sui gRPC works (L-T2). Its Sui JSON-RPC does not (404), so there is no fallback. Credit cost and plan limits are unverified (A9). Tatum sits behind one gateway with a mock.

What keeping it costs us (from the code; money cost unverified):

- One required secret (`TATUM_API_KEY`) to custody and rotate; the key pasted into chat still needs rotating.
- Credits per call are unknown; code assumes 2 and enforces a per-workspace credit budget and a token bucket (`TATUM_FREE_RPS`). Real usage has never been read from the Tatum dashboard.
- About 2,350 lines in `packages/chain/src` (gateway 602, gRPC 398, JSON-RPC 241 that is inert for Sui, mock server 293, verifiers 493, rest small) plus vendored protos and fixtures. The JSON-RPC backend is maintained code with no working Sui endpoint.
- Sui is in a Tatum tier without an uptime guarantee (architecture section 11; unverified this session), so degraded mode is expected.

What swapping it would take:

- Verifiers, worker jobs and the rest of the product call `TatumGateway` and never a backend, so they do not change.
- The gRPC backend speaks standard `sui.rpc.v2`, but it hardcodes the `x-api-key` metadata header and `createGatewayFromEnv` requires `TATUM_API_KEY`. A different Sui gRPC provider needs: a configurable auth header (or none), provider-neutral env names, fixtures recorded from that provider, the existing gateway tests re-pointed, and a live smoke run. Whether another provider serves the same proto revision is unverified.
- The class and file names (`TatumGateway`, `tatum.ts`) and the confinement rule reference Tatum by name; renaming is optional.

Latency (Phase 2):

Measured on testnet, 2026-11-16 15:34Z and 15:35Z (`scripts/tatum-latency.ts`, every call `fresh`, paced at the default 3 calls a second, two runs of 20 package-version reads and 20 transaction reads each):

|                                                                    | Run 1          | Run 2                               |
| ------------------------------------------------------------------ | -------------- | ----------------------------------- |
| TCP connect to `sui-testnet-grpc.gateway.tatum.io:443` (5 samples) | 170 to 2185 ms | 135 to 1012 ms                      |
| TLS handshake including TCP (5 samples)                            | 389 to 5699 ms | 407 to 763 ms                       |
| Package versions: first call (opens the connection)                | 1785 ms        | 1473 ms                             |
| Package versions: later calls p50 / p95                            | 322 / 1851 ms  | 357 / 1127 ms                       |
| Transactions: first call                                           | 368 ms         | 712 ms                              |
| Transactions: later calls p50 / p95                                | 331 / 1039 ms  | 294 / 1044 ms                       |
| Attempts that failed with `unavailable` and were retried           | 10 of 50       | 10 of 50 (4 package, 6 transaction) |

The 4143 ms average in the earlier demo run came from connection setup and retries on this link; once connected a call takes about 0.3 s. The p95 is driven by retries.

What the measurements changed: `buiry_check` used to wait for up to three re-verifications in sequence (4 s cap each). They now run in parallel and the briefing waits at most 1.5 s (`checkReverifyBudgetMs`); slower checks finish in the background. Remaining cost of keeping Tatum: credits per call are still unmeasured against the dashboard (A9; the client estimates 2 per attempt, including failed attempts: 100 for 40 reads in one run), and one attempt in five needed a retry on this connection.

Plan: keep it, do not expand it. To decide, the owner reads real credit usage on the Tatum dashboard for the counts above (two latency runs: 50 attempts each; the fresh-package demo: 4 calls), then one other Sui gRPC provider can be tested with `scripts/tatum-latency.ts` through the same gateway interface.

## 10. Prioritised next steps (each with an acceptance check)

1. Done: testnet demo, live checks, security review with every finding fixed, key custody tooling, backups, onboarding under the single-tenant guard. See section 4 and `docs/PROGRESS.md`.
2. **Postgres checks** (L-BAK1, L-KEY1). Accept when both outputs match the expected lines in `LOCAL_CHECKS.md`.
3. **Deploy to AWS on testnet first** (L-AWS1 to L-AWS3). Accept when `scripts/smoke-deploy.ts --network testnet` passes against the live URL, a memory is stored from a connected agent, and the first scheduled backup appears in the bucket.
4. **Restore drill** on the deployed stack (`docs/OPERATIONS.md`). Accept when a restored copy passes `buiry doctor` and lists a known blob id.
5. **L-BYO1 and L-M1** with the owner's accounts. Accept when `byo-live.ts` prints PASS and a sign-in email arrives and works once.
6. **Publish** the three packages under the confirmed names. Accept when `pnpm release:smoke` passes against the registry versions.
7. **Mainnet cutover checklist** (a deliberate flip at the end):
   - Separate keys and a separate `.env.mainnet`; never reuse testnet keys.
   - **Delegate rotation procedure:** in the Mainnet Walrus Memory dashboard (owner wallet), add a new delegate key and put its private half only in `.env.mainnet`; run the preflight and L-W1 with it; then remove the old delegate. Removing a delegate raises the account's `access_counter_version`, so the removed key cannot fetch keys for new memories. Keys it already fetched still decrypt the memories they were fetched for (A26), so treat a leaked delegate or session as having exposed those memories. Rotate the Tatum API key the same way (new key, verify, revoke old).
   - Re-run every live check on Mainnet (preflight, L-W1, L-W2, L-T2, the demo), then flip `BUIRY_ENV_PROFILE` to mainnet.
8. Only then: Microsoft Imagine Cup and any Azure move.

## 11. How to resume

Read first: `CLAUDE.md`, this file, `docs/PROGRESS.md`.
Run: `git pull`, `pnpm install`, `pnpm typecheck && pnpm lint && pnpm test`, `pnpm demo`, `git log --oneline | head -20`.
Then open `LOCAL_CHECKS.md` for the next live check.

## Configuration found wrong in `.env` (owner to fix)

- `WALRUS_NETWORK=testnet` while `WALRUS_RELAYER_URL` is the Mainnet relayer (A27). The server now refuses to start with that mix. Testnet work uses `.env.testnet` through `scripts/with-env.ts`; `.env` stays for the later Mainnet cutover (or becomes `.env.mainnet`).

- `TATUM_NETWORK` is `testnet` and `TATUM_GRPC_ENDPOINT` is a URL with a scheme and a path, not the documented `sui-mainnet-grpc.gateway.tatum.io:443`; with these values the gateway gets HTTP 400 (as the custom gateway host did on 2026-10-28). The Walrus Memory package is on mainnet, so the Seal session's package check needs the mainnet host. Live runs on 2026-11-10 overrode both values in-process; `.env` itself was not edited.
