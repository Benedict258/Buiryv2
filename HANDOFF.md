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

Architecture doc wins, then the PRD, then the whitepaper. The UI spec is for the dashboard. `CLAUDE.md` holds the non-negotiable rules.

Docs: `docs/01-whitepaper.md`, `02-prd.md`, `03-architecture.md`, `04-ui-spec.md`, `ASSUMPTIONS.md`, `DECISIONS.md` (BD1 to BD31), `PROGRESS.md`, `BLOG_OUTLINE.md`, `diagrams/architecture.mmd`, plus `LOCAL_CHECKS.md` and `README.md` at the root.

`ASSUMPTIONS.md` uses IDs A1 to A22. A18 (Tatum free-plan rate limit) and A19 (gRPC credit cost) were cited but never defined; they are now defined, reconstructed from architecture section 11 and marked as such. The register table's `Status` column now reads `confirmed`, `wrong-and-fixed` or `open` per assumption.

## 3. Architecture at a glance

pnpm monorepo, TypeScript (strict, ESM), Node 20 or newer (`engines`). CI runs Node 20. "Built on 22" is unverified; the gate was last run on Node 24.16 (Windows).

| Path               | What it does                                                                                                                                                                                                                                                                                             | Licence                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `packages/core`    | Pure logic, no I/O: memory header codec, namespaces, idempotency keys, redaction, prompt-injection scanner, learning loop, briefing builder, BUIRY.md, tool protocol types                                                                                                                               | Apache-2.0                 |
| `packages/storage` | The only place that talks to Walrus: signed HTTP relayer client, mock relayer, durable write queue (in-memory and Postgres), write worker, recall merge, expiry reconcile                                                                                                                                | proprietary (`UNLICENSED`) |
| `packages/chain`   | The only place that talks to Tatum: gateway `tatum.ts` with transports in `tatum/` (gRPC only by default; the JSON-RPC backend is added only when `TATUM_JSONRPC_URL` is set, including in mocks and tests), mock Tatum server, vendored Sui protos, verifiers                                           | proprietary (`UNLICENSED`) |
| `packages/mcp`     | MCP server: 13 tools, 3 resources, 2 prompts, stdio and Streamable HTTP, REST client backend. npm name `@buiry/mcp`, binary `buiry-mcp`                                                                                                                                                                  | Apache-2.0                 |
| `packages/api`     | Postgres schema (migrations 001 to 005) with row-level security, memory service, auth (sessions, wallet, OAuth, email link), 90 REST routes (74 user/auth/public routes plus 16 `/v1/agent/*` operations), SSE live feed, webhooks, packs, branches and merge, public showcase, dashboard static serving | proprietary (`UNLICENSED`) |
| `packages/worker`  | Server entry (binary `buiry-server`, `src/bin.ts`) and scheduled jobs: write-drain, relayer-probe, expiry-scan, webhooks (delivery), drift-scan, snapshot, isolation-canary                                                                                                                              | proprietary (`UNLICENSED`) |
| `packages/cli`     | `buiry` command: login, init, connect, status, doctor, briefing, remember, recall, verify, export, import, branch, sync, evidence                                                                                                                                                                        | Apache-2.0                 |
| `apps/dashboard`   | Vite + React + TypeScript SPA built from the UI spec                                                                                                                                                                                                                                                     | proprietary (`UNLICENSED`) |
| `scripts`          | conformance (30 checks), demo (mock and `--live`), write-demo-memories, dev-server, dashboard-shots, chain-smoke, db-smoke                                                                                                                                                                               | proprietary                |

Root `LICENSE` is MIT (pre-existing, left untouched per BD1). This conflicts with the per-package split in CLAUDE.md rule 5 and `NOTICE`. Owner decision.

### Confinement rules (enforced by ESLint `no-restricted-imports` and `packages/chain/test/confinement.test.ts`)

- Walrus access only in `packages/storage`.
- Chain and Tatum access only in `packages/chain/src/tatum.ts` and `packages/chain/src/tatum/`; only the gateway reads `TATUM_API_KEY`.
- Namespaces are derived server-side only: `buiry.v1.<project_id>.<branch_slug>`.
- Memory text is untrusted data whenever it reaches an agent.

### Key design points

- **Event-sourced memory.** Tier A events are durable (written to Walrus); tier B events are local. Each stored record has a header line, a body, and evidence lines.
- **Two idempotency layers (BD13).** A request-level key (client-supplied `client:` prefix or content hash) and a storage-level key (hash of namespace, header and text), sent to the relayer as `idempotency_key` with an `.a<n>` suffix on retries. Architecture section 6 describes both.
- **Learning loop** (`packages/core/src/learning.ts`, architecture section 9).
  - Agent memories start at confidence 0.35.
  - Verified evidence raises it (cap 0.9); helpful reports raise it, at most two increments per memory per day (agent reports weigh 0.5, human 1.0).
  - Per-type half-life decay is applied at read time.
  - Auto-promotion counts only reports from sessions other than the creator's (BD9). An agent can never confirm its own memory (BD11).
  - Per-project overrides for promotion, half-lives and review threshold are applied via `learningFor` (BD27).
- **Drift.** A package upgrade turns a cited deployment memory stale, raises a critical flag, and shows it to the next agent in `buiry_check`.
- **Tenant isolation, three layers (BD18).** The token or session fixes the tenant; every lookup is scoped and answers `not_found` for foreign ids; Postgres row-level security under an unprivileged role. `packages/api/test/isolation.test.ts` has 38 tests and enumerates the route registry and every MCP tool.
- **Auth.** Opaque session tokens (HttpOnly cookie, Origin check on cookie writes; bearer also accepted), agent tokens, API tokens (all stored as keyed hashes), wallet challenge, OAuth adapters (GitHub, Google), email magic link.
- **Write path.** Durable lease-based queue with backoff, dead-lettering, reconciliation of uncertain submits, admission budgets and backpressure, so storage outages queue writes and never lose them (tested on mocks only).
- **Briefings.** Token-budgeted, with a fixed untrusted-data preamble. The dashboard can show the score breakdown per item; agents never receive scores (BD29).
- **Public showcase (BD31).** `GET /v1/public/showcase/:id` answers only for projects whose owner enabled it, with only the ticked sections and only confirmed memories. Agent names, activity and tokens are never included.

## 4. State of the build

### Gate (run in this session on `ef146be`, Windows, Node 24.16, pnpm 10.28.0 via corepack)

- `pnpm install`: ok, lockfile up to date, working tree unchanged.
- `pnpm typecheck`: root `tsc` passed; the script then calls `pnpm --filter @buiry/dashboard typecheck`, which failed only because `pnpm` was not on PATH (corepack shim not enabled). Run separately, the dashboard typecheck passed. So typecheck passes when `pnpm` is on PATH.
- `pnpm lint`: passed (ESLint and Prettier).
- `pnpm test`: 33 files, 372 tests, all passed. Matches the previous networked-machine count at `ef146be`. The "344 on the cloud copy at `0464026`" figure is unverified; `0464026` is where `origin/ccr-e0e1030c-5n01et` points, 11 commits behind `main`.
- Not run this session: `pnpm test:cov`, `pnpm conformance`, `pnpm demo`, dashboard build.

### Built and tested on mocks

Everything in section 3.

### Verified live (per `LOCAL_CHECKS.md` "Live results"; not re-run in this session)

- Walrus relayer, unsigned endpoints only: `/health`, `/version`, `/config`. `/config` reports `securityDeleteEnabled: true` on the public relayer.
- Tatum Sui gRPC (`sui-mainnet-grpc.gateway.tatum.io:443`) for service info, object, package versions and transaction (L-T0, L-T2).
- Real PostgreSQL: migrations 001 to 005 apply and the tenant transaction sees only its own workspace (L-A3). Server health ok; `POST /mcp` without a token returns 401; built dashboard served at `/` (L-A4).
- Real clients, config shape (L-M2, partial): Claude Code 2.1.312 loaded the generated entry via `--mcp-config` and saw all 13 tools (the user-level `~/.claude.json` location itself was not exercised). OpenCode 1.19.5 `mcp list` showed `buiry` connected. Codex 0.165.0 `mcp get` parsed the entry. Cursor not tested.
- Claude Code behaviour (L-M1, partial): in 3 of 3 runs it called `buiry_connect` and `buiry_check` before editing and `buiry_handoff` at the end. One client, pointer-file path only, n=3. Do not quote it as a general rate.
- Wallet signing (L-A2, partial): a signature from `@mysten/sui` 2.38.0 verifies on the real server; a mismatched key and a replayed nonce are rejected. No browser wallet.
- Dashboard in Chrome: L-U1 against the dev server (mocks, automated, not a human walk-through); L-U2 email-link sign-in, cookie, reload persistence and cross-origin 403 against a real server and real Postgres; L-U3 showcase on/off (partial).

### Not verified

- Every signed Walrus call: remember, recall, bulk, restore, expiry listing (A1, A2, A3, A6, A13 signing). Blocked on the delegate private key.
- The live demo (L-D1). Also needs an upgraded Mainnet package and its publish/upgrade digest.
- OAuth sign-in with real apps (L-A1, A21).
- Cursor config; OpenCode and Codex behaviour (need a model login).
- Tatum credit usage and plan limits (A9). Credit figures in code are client-side estimates (2 per call).
- Tatum State, TransactionExecution and Name gRPC services.
- Invitation create and accept flow in a browser.
- The EVM verifier against a real endpoint.

### Assumptions that live checks proved wrong (fixed, with tests)

- **A13, request signing:** headers are `x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, `x-account-id`; the signed string differs; `x-delegate-key` (deprecated, carries a private key) is never sent. Whether the relayer accepts the signature is still unproven.
- **A14, relayer paths and shapes:** routes are `/api/*` and `/v1/owners/{owner}/memories`; job state is `status`; recall returns `distance`; idempotency keys exist; `/api/analyze` is fact extraction, not "unused memories".
- **A4:** restore returns counts only, never memory text.
- **A8, JSON-RPC:** Tatum's documented Sui JSON-RPC hosts returned 404; public fullnodes reject JSON-RPC as deprecated. gRPC is the only working Sui transport. With gRPC down, chain checks report `unknown` and degraded, never a stale pass. The JSON-RPC backend still exists in code and is wired only if `TATUM_JSONRPC_URL` is set.
- **Chain id:** gRPC returns the base58 chain digest, not the 4-byte JSON-RPC form.
- **Custom Tatum gateway host:** served neither Sui JSON-RPC nor gRPC. Do not use it.

### Bugs found only by live runs (fixed)

- Email sign-in link did not sign anyone in (token lost in the signed-out redirect).
- Built CLI and MCP `dist` imported unbuilt workspace source; now bundled.
- Windows: CLI exit code non-zero after successful network calls; fixtures path built with `new URL().pathname`.
- gRPC endpoint URLs are normalised to `host:443`; delegate key parsing accepts `suiprivkey1...`.
- LOCAL_CHECKS said to use `BUIRY_MAILER=memory` for CLI login, which makes email login impossible.
- Per-address rate limit on `/v1/auth/*` also counted signed-in endpoints; now only unauthenticated ones.
- Retries reusing a failed idempotency key: the fix is in code (`packages/storage/src/write-worker.ts` suffixes the relayer key with `.a<attempt>` on retries), but that it was found by a live run is unverified; it is not recorded in PROGRESS or LOCAL_CHECKS.

## 5. Blockers that need a human

1. **Walrus delegate private key.** The value held so far is the public key. Signing needs the private half (64 hex or `suiprivkey1...`). If lost, add a new delegate in the Walrus Memory dashboard and remove the old one. Set `WALRUS_DELEGATE_KEY` in the gitignored `.env`.
2. **npm name.** `@buiry/mcp` resolves to the v1 package (0.1.8) per LOCAL_CHECKS (unverified this session). Decide: publish v2 as a new major and deprecate v1, or use a new name. Until then `BUIRY_MCP_COMMAND` overrides what `buiry connect` launches.
3. **Demo inputs.** `DEMO_PACKAGE_ID` (an upgraded Mainnet package) and `DEMO_TX_DIGEST`.
4. **OAuth apps** for GitHub and Google, if wanted.
5. **Rotate keys that were pasted into chat:** the Tatum API key now, the Walrus delegate once checks are done. (No key value was found in tracked files or git history in this session.)
6. **Tatum decision** (section 9).
7. **Root licence** (MIT vs the Apache/proprietary split).
8. Anything in `LOCAL_CHECKS.md` that still reads blocked, partial, not run or needs you.

## 6. Setup and commands

Requires Node 20 or newer and pnpm 10.28.0 (`packageManager`). On Windows, `npm i -g pnpm@10.28.0` if corepack needs admin rights. `corepack pnpm <cmd>` works without enabling shims, but `pnpm typecheck` and `pnpm build` call `pnpm` internally, so `pnpm` must be on PATH.

- `pnpm install`
- `pnpm typecheck && pnpm lint && pnpm test`
- `pnpm test:cov`, `pnpm conformance`, `pnpm demo` (mocks), `pnpm demo --live`
- Dashboard on mocks: `pnpm --filter @buiry/dashboard build`, then `pnpm dev:api`. It prints a workspace id, a project id and a session token. Note: the `dev:api` script is `DASHBOARD_DIR=apps/dashboard/dist tsx scripts/dev-server.ts`, an inline variable that Windows shells do not support; on Windows set `DASHBOARD_DIR` first and run `pnpm tsx scripts/dev-server.ts` (unverified; not run this session).
- Server: `pnpm tsx packages/worker/src/bin.ts` (REST on `/v1`, MCP on `/mcp`).
- CLI from source: `pnpm tsx packages/cli/src/bin.ts <command>`.
- Screenshot pass: `pnpm dashboard:shots <token> <workspace-id> <project-id>` (`CHROMIUM_PATH` overrides the browser).
- Chain smoke: `pnpm tsx scripts/chain-smoke.ts`. Database smoke: `pnpm tsx scripts/db-smoke.ts`.
- Write demo memories: `pnpm tsx scripts/write-demo-memories.ts --valid-until <date>`.

Windows notes: `.gitattributes` forces LF (`* text=auto eol=lf`); inline `VAR=value command` does not work in cmd or PowerShell; the credentials-file 0600 check is not a skipped test but a conditional assertion inside one test, so on Windows the test passes without checking the mode.

### Environment variable names (values only in the gitignored `.env`)

`.env.example` lists every name below (names only, grouped, with a comment where the meaning is not obvious). The unused `REDIS_URL` was removed.

Read by the code (from a grep of `packages`, `scripts`, `apps`):

- Walrus: `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID`, `WALRUS_DELEGATE_KEY` (private), `WALRUS_NETWORK`.
- Tatum: `TATUM_API_KEY`, `TATUM_NETWORK`, `TATUM_GRPC_ENDPOINT`, `TATUM_JSONRPC_URL`, `TATUM_FREE_RPS`.
- Server: `DATABASE_URL`, `BUIRY_SECRET_KEY`, `BUIRY_BASE_URL`, `BUIRY_ALLOWED_ORIGINS`, `BUIRY_MAILER`, `BUIRY_ENTITLEMENTS`, `DASHBOARD_DIR`, `PORT`, `NODE_ENV`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- CLI and MCP client: `BUIRY_API_URL`, `BUIRY_TOKEN`, `BUIRY_MCP_COMMAND`. Dashboard dev proxy: `BUIRY_API`.
- Scripts and tests: `DEMO_PACKAGE_ID`, `DEMO_TX_DIGEST`, `DEMO_NETWORK`, `VALID_UNTIL`, `BUIRY_CONTRACT_RELAYER_URL`, `SMOKE_TX`, `SMOKE_OBJECT`, `SMOKE_PACKAGE`, `CHROMIUM_PATH`, `DASHBOARD_URL`.

`WALRUS_DELEGATE_PUBLIC_KEY` is not read by any code or named in any doc; it may exist only in a local `.env` (unverified).

## 7. Rules and lessons

- No AI attribution in commits, PRs or files. Small, focused commits. No attribution lines appear in commit messages, but the 15 commits from `68699b4` to `0464026` have `Claude <noreply@anthropic.com>` as author. The owner chose not to rewrite now; a rewrite plan comes later and needs the owner's approval before any force-push. New commits use the repo-local identity `ISAAC BENEDICT`.
- Never commit secrets. Gitleaks runs in CI (`.github/workflows/ci.yml`). Scan staged diffs and the commit range before any push. Never echo key values into logs, docs or commit messages.
- Do not invent facts about Walrus or Tatum. Unconfirmed things go behind an interface, get mocked, and are logged in `docs/ASSUMPTIONS.md` with source, how to verify, and what changes if false.
- Never fake a live result. Every real-network check is recorded in `LOCAL_CHECKS.md` with the exact command and what to paste back.
- Mocks hid real bugs. A live run is the only proof of live behaviour.
- Do not chain `lint` after `commit` with `;`; gate first, then commit.
- After each step: typecheck, lint, test, commit, update PROGRESS.md and LOCAL_CHECKS.md.
- Keep chat output concise; detail belongs in docs.
- CLAUDE.md rule 4 (no timelines or schedules in files) and the "run the late write close to the deadline" step (LOCAL_CHECKS L-D2, architecture section 14 item 6) came from the hackathon. Re-decide them (section 8). PRD section 14 already contains event dates, which rule 4 forbids.

## 8. What shifts now that it is not a hackathon

- **Remove or generalise hackathon framing** in: `README.md` (intro line and "Hackathon evidence" section), `LOCAL_CHECKS.md` (L-T3, L-D2), `docs/PROGRESS.md` ("hackathon evidence report"), `docs/ASSUMPTIONS.md` (A7), `docs/01-whitepaper.md`, `docs/02-prd.md` (section 14 and elsewhere), `docs/03-architecture.md` (sections 6, 11, 14 and A7), `packages/api/src/service/dashboard.ts` (comment on the evidence report), `packages/api/src/http/context.ts` (comment), `packages/cli/test/cli.test.ts` (test name). `docs/BLOG_OUTLINE.md` has no hackathon references. No dashboard UI string mentions the hackathon.
- **Keep, but rename if useful:** `buiry evidence` and `GET /v1/projects/:id/evidence-report` (useful as a storage and verification report), and `write-demo-memories` (useful as a seeding tool).
- **Revisit CLAUDE.md rules:** the "no timelines" rule and the deadline wording.
- **Production gaps to close:**
  - Walrus storage is time-limited; the docs say lapsed memories cannot be renewed, and renewal by the operator is unconfirmed (A1). Expiry alerts exist; a renewal or export-and-rewrite path does not.
  - The public relayer's limits (architecture section 6: 60 weighted requests per minute, 500 per hour per account; a remember costs 5) mean managed multi-tenant use needs a self-hosted relayer.
  - Only one Sui chain transport works (gRPC). The gateway from env is built for a single network (`TATUM_NETWORK`), so the network-sanity probe of "other configured networks" has nothing to probe unless more backends are configured in code.
  - Hosting and deployment target, backups, monitoring and alerting, secrets management, key custody for the Walrus account and delegates.
  - Licence model (root MIT vs per-package split), npm naming and publishing, versioning, security review, privacy and data-deletion promises.
  - Billing and plan limits are placeholders (BD21).
  - Placeholders listed in BD26: bulk move-to-branch and flag notes, memory renewal, billing payment methods, browser wallet connect, the marketing site, the internal admin console.
- **Do not claim publicly:** a general Claude Code behaviour rate, live Walrus write performance, or a working JSON-RPC fallback. None is verified.

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

Plan: keep it, do not expand it, decide after the prototype works. To decide, read real Tatum credit usage, then test one other Sui gRPC provider against `scripts/chain-smoke.ts`.

## 10. Prioritised next steps (each with an acceptance check)

1. Get the delegate private key into `.env`. Run L-W1 and L-W2. Accept when a signed `remember` is stored, recalled and its expiry is read back, and every mock-versus-real difference is fixed with a regression test and logged in ASSUMPTIONS.
2. Run the live demo (L-D1). Accept when agent B is shown agent A's failure first, the package upgrade marks the deployment stale, the corrected memory is created from the digest, and the evidence report shows real blob ids and expiries.
3. Strip hackathon framing (section 8) and settle the CLAUDE.md rules. Accept when no doc or UI string refers to the hackathon and the gate passes.
4. Retention and renewal story for Walrus expiry. Accept when a memory near expiry can be exported or rewritten, and the dashboard says exactly what will happen.
5. Production deployment: pick a host, set up secrets, backups, health checks, monitoring and alerts, and a documented restore. Accept when a fresh deploy passes the live smoke checks.
6. Package and publish: settle the npm name, make builds self-contained, add a clean-install test. Accept when `npx` runs the right server on a machine with nothing else installed.
7. Close the placeholders worth keeping from BD26 and decide which to drop.
8. Tatum decision (section 9).
9. Only then: look at the Microsoft Imagine Cup rules and any Azure migration.

## 11. How to resume

Read first: `CLAUDE.md`, this file, `docs/PROGRESS.md`.
Run: `git pull`, `pnpm install`, `pnpm typecheck && pnpm lint && pnpm test`, `pnpm demo`, `git log --oneline | head -20`.
Then open `LOCAL_CHECKS.md` for the next live check.

## Changes since the audit (owner's go-ahead)

- Chain: gRPC only by default everywhere, including mock worlds and test rigs; JSON-RPC only when `TATUM_JSONRPC_URL` is set; env-level tests added. Architecture section 11 and decision record 4 updated.
- Architecture section 6 describes both idempotency layers. PROGRESS Step 0 status and route count fixed.
- LOCAL_CHECKS: the Step 0 docs check is now L-S0, so L-D1 is only the live demo.
- ASSUMPTIONS: A18 and A19 defined (reconstructed), A17 to A19 added to the register, statuses set.
- `.env.example` lists every variable the code reads; `REDIS_URL` removed.

## Corrections made

- HANDOFF.md did not exist on disk or in git history; created from the pasted draft.
- Gate: replaced the reported counts with this session's run (33 files, 372 tests passing); noted that `pnpm typecheck` needs `pnpm` on PATH; marked the 344 cloud figure unverified and identified `0464026` as `origin/ccr-e0e1030c-5n01et`.
- Licences: `storage`, `chain`, `api`, `worker`, `dashboard` are `UNLICENSED`; added that the root `LICENSE` is MIT (BD1), which the draft omitted.
- Worker: added the `webhooks` delivery job (seven jobs, not six) and that the server entry lives in `packages/worker`.
- Routes: "about 90" is exactly 90 by count (74 plus 16 agent operations); PROGRESS says "about 85".
- Learning loop: "daily cap" made specific (two helpful increments per memory per day, agent weight 0.5); evidence cap 0.9.
- Env vars: `WALRUS_DELEGATE_PUBLIC_KEY` is not used anywhere; added names the code reads that the draft omitted (`TATUM_FREE_RPS`, `BUIRY_API_URL`, `BUIRY_API`, `BUIRY_TOKEN`, `NODE_ENV`, `DEMO_NETWORK`, `BUIRY_CONTRACT_RELAYER_URL`, `SMOKE_*`, `CHROMIUM_PATH`, `DASHBOARD_URL`); noted `.env.example` lists only 11 and includes the unused `REDIS_URL`.
- Hackathon framing list: removed `docs/BLOG_OUTLINE.md` (no references); added `docs/ASSUMPTIONS.md` (A7) and the specific sections; noted the `context.ts` and `dashboard.ts` hits are comments only.
- JSON-RPC: clarified that the backend is still wired when `TATUM_JSONRPC_URL` is set, not removed.
- Windows: the 0600 credentials check is a conditional assertion, not a skipped test; `pnpm dev:api` uses an inline variable that Windows shells do not support.
- Node: "built on 22" marked unverified; CI uses Node 20.
- "Retries reused a failed idempotency key" marked unverified as a live-found bug (not in PROGRESS or LOCAL_CHECKS).
- `@buiry/mcp` resolving to v1 0.1.8 marked as reported in LOCAL_CHECKS, unverified this session.
- LOCAL_CHECKS has two sections both named L-D1 (Step 0 docs reading and the live demo); noted in next steps.
- ASSUMPTIONS: noted A18 and A19 are undefined and the original table's statuses are stale.
- Tatum section: added the measured cost-to-keep and the concrete swap work from the code.
- Added the root-licence decision to blockers, and the single-network gateway and relayer rate limits to production gaps.
