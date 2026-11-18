# Architect briefing: Buiry v2

This briefing is for a chief architect and reviewer who has no access to the repository or to earlier conversations. It is built from the repository (`CLAUDE.md`, `HANDOFF.md`, `docs/*`, `LOCAL_CHECKS.md`, git log). Every number names the file where it is recorded. Where the repository records no reason for something, this briefing says so.

## 1. What Buiry is, and the current goal

Buiry is a shared project memory for AI coding agents.

- Agents (Claude Code, OpenCode, Codex and others) connect over MCP. Before a task they read a briefing; while working they record typed memories with evidence. They report whether a memory helped, and they hand off to the next session or tool.
- Memory belongs to the project, not to one tool. Switching agents keeps the project's decisions, constraints, past failures and stale facts.
- Memory text is stored on **Walrus Memory**, a Walrus-based storage service reached through a relayer. A deterministic learning loop scores memories.
- Evidence such as "this deployment cites package version 1" is checked against the Sui chain through **Tatum**'s Sui gateway.
- People govern the memory from a **dashboard**: review, confirm, contest, branch, merge, export.

**Current goal** (`HANDOFF.md` section 1): a working, production-grade prototype for our own use. The project began as an entry to a hackathon run by Tatum and Walrus; that goal is dropped. The Microsoft Imagine Cup, and possibly moving parts of the system to Azure, come only after the prototype works.

## 2. Decisions already made

| Decision                                                                                                                                              | Reason (as recorded)                                                                                                                                                                                                       | Where                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Keep Walrus Memory as the storage layer                                                                                                               | Owner decision; no further rationale is recorded.                                                                                                                                                                          | `HANDOFF.md` s1        |
| Testnet first; Mainnet is a deliberate cutover at the end. Each run loads an explicit environment profile, and a mixed-network setup refuses to start | A Mainnet relayer behind testnet labels went unnoticed (A27); a mixed setup breaks Seal sessions and verification silently                                                                                                 | BD33                   |
| Bring-your-own Walrus account per project comes first. Managed mode (the shared account) serves a single tenant                                       | One Seal session reaches every tenant on an account (A26), so a shared account is not tenant-safe. BD41: ownership must not depend on who writes first, and a second user gets a way forward rather than a silent fallback | BD36, BD41             |
| Production should name the managed tenant explicitly                                                                                                  | Without `BUIRY_MANAGED_WORKSPACE_ID`, the first workspace to create a managed project claims the account                                                                                                                   | BD41, `ASSUMPTIONS.md` |
| AWS as host: ECS Fargate (API and worker), RDS Postgres, ALB, Secrets Manager, S3 backups                                                             | Owner choice. The repository records the design (`docs/DEPLOYMENT.md`) but no comparison or rationale. Nothing is applied yet                                                                                              | `DEPLOYMENT.md`        |
| Keep Tatum for now behind one gateway: do not remove it, do not expand it, revisit after the prototype                                                | Its Sui gRPC works; its Sui JSON-RPC does not, so there is no fallback. Credit cost is unmeasured (A9). Swapping providers touches only the gateway's backend                                                              | `HANDOFF.md` s9        |
| npm names: `@buiry/core`, `@buiry/mcp-server`, `@buiry/cli`, set in `release.json` only. Nothing published                                            | `@buiry/mcp` is the published v1 package (0.1.8). Naming is the owner's call, and one setting changes it                                                                                                                   | BD39                   |
| Licence split: `core`, `mcp` and `cli` are Apache-2.0; everything else is proprietary (`UNLICENSED`). The root `LICENSE` is a per-package notice      | `CLAUDE.md` rule 5. The earlier MIT text contradicted it. The notice still needs a legal re-read                                                                                                                           | BD1                    |
| No timelines in files; no AI attribution                                                                                                              | Owner rules                                                                                                                                                                                                                | `CLAUDE.md`            |

## 3. Current state (as of the commit in section 10)

**Gate and tests.**

- Typecheck (root and dashboard), ESLint and Prettier pass, and all 487 tests in 53 files pass.
- Conformance passes 30/30.
- `pnpm audit --prod` reports 0 advisories.
- Recorded in: `HANDOFF.md` s4 and `docs/PROGRESS.md` ("Final checks").

**Built.** Every package in section 5, the dashboard, the CLI, and these additions:

- the AWS deployment files (Terraform validated offline);
- the `BUIRY_SECRET_KEY` rotation tool;
- backup and restore scripts;
- onboarding under the single-tenant guard.

**Verified live on testnet** (`LOCAL_CHECKS.md` "Live results"; each line names its network):

- Walrus Memory on testnet:
  - signed writes;
  - recall with a Seal session, returning every memory with its text;
  - reading expiry (L-W1T, L-W2T).
- Tatum Sui testnet gRPC (L-T4).
- The two-agent live demo, fresh-package run (L-D1, `docs/EVIDENCE.md`). "All checks passed":
  - a deployment memory is verified when written;
  - it turns stale only after a real package upgrade between sessions.
- Renewal by rewrite (L-R1).
- Dashboard walkthrough, 21/21 steps (L-UI1). It covers sign-in, onboarding, invitations, permissions and the second-user guidance.
- Claude Code behaviour: 10/10 runs; OpenCode: 2/2 (`docs/BEHAVIOUR.md`).
- Light smoke and load run: 6 of 6 stored in 204 s; briefing p50 63 ms; recall p50 1.9 s, maximum 18 s (`docs/LOAD.md`, `LOCAL_CHECKS.md` L-LOAD2).

**Verified live on Mainnet earlier** (A27: the relayer served Mainnet while `.env` said testnet):

- signed remember, bulk write, restore and listing;
- recall with a Seal session;
- expiry: 15 epochs, about 210 days (L-W1, L-W2);
- Tatum Mainnet gRPC (L-T0, L-T2).

**Verified against real Postgres once** (L-A3, L-A4): migrations 001–005 and row-level security. **Migrations added since then have run only on PGlite.**

**Verified only on mocks or PGlite:**

- the durable write queue under storage outages;
- relayer rate limits under sustained load;
- bring-your-own accounts (L-BYO1 is waiting for a second account);
- the SMTP mailer (fake server only);
- key rotation (L-KEY1 is pending on Postgres);
- backups (L-BAK1 used stub tools);
- every Terraform and Docker artifact.

**Not verified at all:**

- OAuth with real apps (L-A1, A21);
- Cursor;
- concurrent agents against Postgres;
- several API tasks behind a load balancer;
- Tatum credit usage (A9);
- the EVM verifier;
- any AWS deployment;
- the live demo on Mainnet.

**Security review** (`docs/SECURITY_REVIEW.md`). It is an internal code reading, not a penetration test.

- There are no critical findings. All 12 findings are fixed with regression tests: three high (H1–H3), seven medium (M1–M7) and two low (L1, L2). M4 is fixed only for new agent tokens.

**Load and latency** (`docs/LOAD.md`). The local runs used PGlite on one Windows machine with sequential calls; treat them as indicative only.

| Operation at 10k memories | p50    | p95    |
| ------------------------- | ------ | ------ |
| Briefing                  | 257 ms | 390 ms |
| Recall                    | 111 ms | 166 ms |
| Remember                  | 124 ms | 225 ms |

- The testnet recall cost is dominated by the relayer and Seal. In one run, 1 recall in 5 took 18 s.
- Five samples are too few to set a timeout from.

**Tatum latency** (`HANDOFF.md` s9): about 0.3 s per call once connected. One attempt in five needed a retry on the measured link.

## 4. Open items

**Security, still open** (`docs/SECURITY_REVIEW.md`, "Still open"):

1. Rate limits, SSE caps and MCP sessions are held per process: N API tasks allow N times each limit, and a restart resets them.
2. API tokens have no default expiry. Agent tokens issued before the expiry change (M4) have none either.
3. The dashboard sets no Content Security Policy.
4. The app connects as the RDS master user, not a least-privilege database user.
5. Two dev-only advisories (picomatch, minimatch) have no fixed release in range.
6. The worker's job handlers, supply chain and expensive-query denial of service were not reviewed.

**Open assumptions** (`docs/ASSUMPTIONS.md` register):

| ID  | Assumption still open                                                                  |
| --- | -------------------------------------------------------------------------------------- |
| A1  | Operator can extend blob lifetimes. Leaning wrong; renewal is done by rewriting (BD37) |
| A6  | Bulk write rate limits and weight                                                      |
| A9  | Tatum credit cost                                                                      |
| A10 | zkLogin                                                                                |
| A11 | Blob field names                                                                       |
| A12 | Self-hosted relayer accepts a header-keyed gateway                                     |
| A18 | Tatum free-plan rate (reconstructed)                                                   |
| A19 | gRPC credit cost (reconstructed)                                                       |
| A21 | OAuth endpoints                                                                        |
| A24 | Public relayer connection timeouts                                                     |
| A25 | One SDK 404                                                                            |
| A29 | `expires_at` is approximate                                                            |

**What only the owner can do, in order** (`HANDOFF.md` s5):

1. Rotate the Tatum API key that was pasted into chat. Rotate the Walrus delegates later, following `docs/KEY_CUSTODY.md`.
2. Run L-BAK1 (backup round trip) and L-KEY1 (key rotation) on a local Postgres.
3. Provide a second testnet Walrus account, then run L-BYO1.
4. Provide an SMTP account for one live sign-in email (L-M1).
5. Build both Docker images, run them against Postgres, and pin them by digest (L-AWS1).
6. Choose the AWS region, domain, database size, backup retention and bucket location; check prices; run `terraform plan` (L-AWS2).
7. Apply and deploy on testnet:
   - set the secrets;
   - set `BUIRY_MANAGED_WORKSPACE_ID`;
   - run the migration;
   - run `scripts/smoke-deploy.ts`;
   - check rate limits behind the ALB (L-AWS3).
8. Confirm the npm names, have the `LICENSE` notice re-read, and publish.
9. Make the Tatum keep-or-move decision from the dashboard's credit usage.
10. Decide on the open security items before any public exposure.
11. Set up OAuth apps, if wanted.
12. Delete the local tag `backup-before-author-rewrite`.
13. Last: the Mainnet cutover checklist (`HANDOFF.md` s10).

## 5. Architecture summary

pnpm monorepo, TypeScript (strict, ESM), Node 20 or newer. Source of truth: `docs/03-architecture.md`, then `02-prd.md`, then `01-whitepaper.md`.

**Packages.**

| Package          | Role                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`           | Pure logic, no I/O: header codec, namespaces, idempotency keys, redaction, prompt-injection scan, learning loop, briefing builder, `BUIRY.md`                                     |
| `storage`        | The only Walrus code: signed relayer client, Seal session, mock relayer, durable write queue, write worker, recall merge, expiry reconcile                                        |
| `chain`          | The only Tatum code: the gateway `src/tatum.ts`, transports in `src/tatum/` (gRPC; JSON-RPC only when `TATUM_JSONRPC_URL` is set), mock server, verifiers                         |
| `mcp`            | MCP server over stdio and Streamable HTTP: 13 tools, 3 resources, 2 prompts                                                                                                       |
| `api`            | Hono REST server (about 90 routes, including `/v1/agent/*`), Postgres schema with row-level security, auth, SSE feed, webhooks, packs, branches, showcase; serves the dashboard   |
| `worker`         | Server entry and jobs: write drains (one per account), relayer probe, expiry scan, renewal, webhooks, drift scan, snapshots, isolation canary; the migrate and rotate-key entries |
| `cli`            | `buiry` command (login, init, connect, doctor, briefing, remember, recall, verify, export, import, branch, evidence, and others)                                                  |
| `apps/dashboard` | Vite, React and TypeScript SPA; hand-written CSS from design tokens                                                                                                               |

**Data flow.**

- **Write:**
  1. An agent calls `buiry_remember` over MCP. The call goes to the REST agent API with an agent token.
  2. The API redacts the text, scans it for injection, and checks two idempotency keys (BD13).
  3. It indexes the memory in Postgres and queues a durable write job.
  4. The worker drains the job to the Walrus relayer and records the blob id.
- **Read:**
  - `buiry_check` returns a token-budgeted briefing built from Postgres. It carries a fixed preamble marking the text as untrusted.
  - `buiry_recall` adds a relayer search that uses a Seal session; the results are merged with the index.
- **Verify:** evidence is checked through the Tatum gateway. If the chain read fails, the result is `unknown` and degraded, never a stale pass.

**Confinement rules** (`CLAUDE.md`; enforced by ESLint `no-restricted-imports` and `packages/chain/test/confinement.test.ts`):

- Walrus access only in `storage`.
- Chain and Tatum access only in `chain/src/tatum.ts` and `chain/src/tatum/`.
- Namespaces are derived on the server only: `buiry.v1.<project_id>.<branch_slug>`.
- Memory text is untrusted data whenever it reaches an agent.

**Learning loop** (`core/src/learning.ts`, architecture s9):

- Agent memories start at confidence 0.35.
- Verified evidence raises confidence, up to 0.9.
- Each "helpful" report raises confidence. At most two increases count per memory per day; an agent's report weighs 0.5 and a person's 1.0.
- Confidence decays with a half-life that depends on the memory type, applied when the memory is read.
- Auto-promotion counts only reports from sessions other than the creator's (BD9). An agent never confirms its own memory (BD11).
- Projects can override the rules (BD27).
- Agents never see scores (BD29).

**Tenant isolation, three layers** (BD18):

1. The token or session fixes the tenant; request fields never name one.
2. Every lookup is scoped, and a foreign id answers `not_found`.
3. Postgres row-level security applies under an unprivileged role.

`packages/api/test/isolation.test.ts` walks the route registry and every MCP tool.

On the storage side:

- A shared managed account serves exactly one workspace (BD41).
- Every other workspace brings its own account, and its delegate key is sealed with AES-256-GCM (BD36).

**Storage adapter.**

- `WalrusMemoryAdapter`, selected per project by a `StorageRegistry`: the managed account, or a bring-your-own account.
- Request signing follows A13; paths follow A14.
- Renewal works by rewriting the stored text under a new key (BD37).

**Chain adapter.**

- `TatumGateway`: a token bucket, a credit budget, and a gRPC backend that speaks standard `sui.rpc.v2`.
- The rest of the product calls only the gateway, so a provider swap is local to `chain`.

## 6. The working agreement

**How Claude Code prompts are written** (the owner's practice):

- One code block per prompt.
- Ordered phases (Phase A, B, and so on), each with clear deliverables.
- Standing rules repeated in every prompt:
  - gate before every commit, one gate per commit;
  - scan before every push; push only if clean, never force;
  - no AI attribution, no secrets, no timelines in files;
  - record sources and versions in `ASSUMPTIONS.md`;
  - update PROGRESS, LOCAL_CHECKS, ASSUMPTIONS and HANDOFF after each phase.
- Stop conditions: "stop and tell me exactly what I must do" wherever an account, a payment, a key or a decision is the owner's.
- Hard limits stated up front, for example no Mainnet writes, no AWS apply, no npm publish.

**Non-negotiable rules** (`CLAUDE.md`):

1. No AI attribution anywhere. Commits are small and focused.
2. Never commit secrets. Configuration comes from the environment, and only `.env.example` is committed. Gitleaks runs in CI.
3. Never invent facts about Walrus Memory or Tatum. Anything unconfirmed sits behind an interface, is mocked, and is logged in `ASSUMPTIONS.md` with the source, how to verify it, and what changes if it is false.
4. No timelines, schedules or estimates in files.
5. The licence split described in section 2.
6. Every real-network check goes into `LOCAL_CHECKS.md` with the exact command and the expected result. Never fake a live result.
7. Ask the owner only for decisions that are genuinely theirs; otherwise pick a default and record it in `DECISIONS.md`.

**Lessons learned** (`HANDOFF.md` s4 and s7, `EVIDENCE.md`, `BEHAVIOUR.md`):

- **Mocks hid real bugs.** Live runs alone found:
  - the wrong relayer headers, paths and shapes (A13, A14);
  - that recall needs a Seal session (A23);
  - that Tatum's JSON-RPC is dead (A8);
  - a sign-in link that did not sign anyone in;
  - built packages importing unbuilt source;
  - a Mainnet relayer behind testnet labels (A27).
- **A live run is the only proof of live behaviour.** Name the network on every claim.
- **Never fake a live result.** "Not run" is an acceptable answer.
- **Gate before every commit and scan before every push.**
- **Small samples are not rates.** For example, the Claude Code behaviour runs (n=3, then 10) are not a general rate.

## 7. How to review a Claude Code report

Check each claim and say plainly when it fails:

- **Overclaims.** "Done", "verified" or "production-ready" with no command, output or file reference. Ask for the evidence line in `LOCAL_CHECKS.md` or the test name.
- **Small samples.** Percentiles from 5 to 20 calls, or behaviour rates from a handful of runs. They are anecdotes; ask for n.
- **Mock versus live.** A test passing against the mock relayer, mock Tatum, PGlite or stub tools is not live evidence. Check that the network (testnet or Mainnet) is named, and that the Postgres claim was real Postgres.
- **Skipped gates.** Every commit needs its own gate (typecheck, lint, Prettier, tests). Check the reported test count against the previous one; a drop without an explanation is a red flag.
- **Assumptions treated as facts.** Any statement about Walrus, Seal, Tatum, AWS or npm behaviour should cite a source URL and version, or an `ASSUMPTIONS.md` ID with its status.
- **Security.** Look for:
  - new routes that are not covered by the isolation suite;
  - secrets or tokens in logs, docs or errors;
  - user-supplied URLs that skip the destination check;
  - memory text reaching agents without the untrusted marker;
  - new limits held only in process memory.
- **Owner-only actions.** Anything involving accounts, payments, keys, publishing or Mainnet writes must be listed as the owner's, not performed or implied as done.

## 8. Glossary (product term, then the exact name in code)

| Term                            | Code name                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory type                     | `MEMORY_TYPES`: `decision`, `constraint`, `fact`, `failure`, `procedure`, `preference`, `task_state`, `deployment`, `handoff` (`core/src/types.ts`)                                                                                   |
| Memory status                   | `STATUSES`: `proposed`, `confirmed`, `contested`, `stale`, `superseded`, `tombstoned`                                                                                                                                                 |
| Briefing                        | `buiry_check` (MCP), built by the core briefing builder                                                                                                                                                                               |
| MCP tools                       | `buiry_connect`, `buiry_check`, `buiry_remember`, `buiry_remember_bulk`, `buiry_recall`, `buiry_report`, `buiry_resolve`, `buiry_verify`, `buiry_handoff`, `buiry_branch`, `buiry_status`, `buiry_chain_read`, `buiry_chain_simulate` |
| Namespace                       | `buiry.v1.<project_id>.<branch_slug>`                                                                                                                                                                                                 |
| Managed storage                 | `walrus_mode = 'managed'`; tenant set by `BUIRY_MANAGED_WORKSPACE_ID`                                                                                                                                                                 |
| Bring-your-own account          | `walrus_mode = 'byo'`, table `project_storage`, `delegate_key_sealed`                                                                                                                                                                 |
| Self-hosted relayer             | `walrus_mode = 'self_hosted'`; refused until it is built                                                                                                                                                                              |
| Delegate key                    | Walrus Memory signing key (`WALRUS_DELEGATE_KEY`); private                                                                                                                                                                            |
| Seal session                    | `packages/storage/src/seal-session.ts`; needed for recall                                                                                                                                                                             |
| Chain gateway                   | `TatumGateway` in `packages/chain/src/tatum.ts`                                                                                                                                                                                       |
| Drift                           | A package upgrade turns a cited deployment memory `stale` and raises a flag                                                                                                                                                           |
| Pack                            | Exported or imported memory bundle; imported as `proposed`                                                                                                                                                                            |
| Showcase                        | Opt-in public project page, `GET /v1/public/showcase/:id`                                                                                                                                                                             |
| Storage and verification report | `buiry evidence`, `GET /v1/projects/:id/evidence-report`                                                                                                                                                                              |
| Agent token / API token         | Keyed-hash tokens; agent tokens expire after `BUIRY_AGENT_TOKEN_MAX_DAYS`                                                                                                                                                             |
| Secret key and overlap key      | `BUIRY_SECRET_KEY`, `BUIRY_SECRET_KEY_PREVIOUS`; the rotation tool is `rotate-key`                                                                                                                                                    |
| Environment profile             | `scripts/with-env.ts <profile>` loads `.env.<profile>`                                                                                                                                                                                |
| Gate                            | Typecheck (root and dashboard), ESLint, Prettier check, vitest                                                                                                                                                                        |

## 9. Next work: site, content and design-system documents

The marketing site is a placeholder today (BD26). These files already exist:

- **`docs/04-ui-spec.md`.** The full UI spec, written for Stitch or Claude Design:
  - s1: direction and brand proposal. The visual choices are proposals; no brand identity is agreed.
  - s2: design tokens.
  - s3: shell.
  - s4: component library.
  - s5: every marketing-site page (home, how it works, features, pricing, security and trust, docs hub, changelog, showcase, open source, sign in, utility pages).
  - s6–9: app screens.
  - s10: state catalog.
  - s11: responsive behaviour and accessibility.
  - s12: microcopy and sample content.
  - s13: paste-ready design-tool prompts.
- **`apps/dashboard/src/styles/tokens.css` and `app.css`.** The tokens and styles actually implemented. They are the de facto design system, with no separate package (BD23).
- **`docs/BLOG_OUTLINE.md`.** Outline of a launch post. Its numbers must come from `buiry evidence` after a real run.
- **Content sources:** `docs/01-whitepaper.md`, `docs/02-prd.md`, `README.md`, `docs/EVIDENCE.md`.

Constraints for this work:

- **Do not claim publicly** (`HANDOFF.md` s8): a general Claude Code behaviour rate, live Walrus write performance, or a working JSON-RPC fallback.
- **Pricing:** BD21 limits are placeholders, not prices.

## 10. Last updated

Matches commit `eb82230` on `main` ("docs: Phase E final checks, HANDOFF state, owner steps and next steps rewritten"), the commit before the one that adds this file.
