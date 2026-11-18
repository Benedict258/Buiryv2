# Development log

Every change made under the design-report brief, and why. History that used to live in `HANDOFF.md` is at the end.

## Phase 0: docs reconciliation (2026-11-18)

| Change                                                                                                                      | Why                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created this file                                                                                                           | The brief requires a change log, and HANDOFF should hold current state only.                                                                                                                                                                      |
| HANDOFF section 2 rewritten                                                                                                 | Source precedence from the brief; counts updated from the code: BD1–BD41 (was BD1–BD31), A1–A29 (was A1–A22), migrations 001–009, 97 routes (was 90).                                                                                             |
| HANDOFF section 3 rewritten                                                                                                 | Migrations, routes, worker jobs, SMTP, renewal and agent token expiry were missing or out of date; published versus workspace npm names (`release.json`) stated.                                                                                  |
| HANDOFF section 4 rewritten (Gate, Verified live, Verified on mocks, Not verified)                                          | Old Gate lines mixed historic runs; the verified list now cites a record per line, adds L-B1, L-UI1, L-R1, L-LOAD2 and the OpenCode run, and names the network.                                                                                   |
| HANDOFF "Gate": `pnpm audit --prod` is now "last recorded 2026-11-16, not re-run"                                           | The Phase E HANDOFF said "audit 0" as current without re-running it. Correcting my own overclaim.                                                                                                                                                 |
| HANDOFF "Not verified" extended                                                                                             | Required by the brief: migrations after 005 on real Postgres, concurrent agents, several API tasks behind an ALB, Cursor, Codex behaviour, OAuth, A9, BYO, Mainnet demo.                                                                          |
| HANDOFF section 8 rewritten as "Production gaps"                                                                            | Renewal by rewrite exists (BD37); the old text said no renewal path existed. Added the single-point-of-loss database and A26.                                                                                                                     |
| "Changes since the audit", "Corrections made" and "Bugs found only by live runs" moved here                                 | History, not current state.                                                                                                                                                                                                                       |
| HANDOFF records that `LOCAL_CHECKS.md` reuses the id L-M1                                                                   | Two different checks share it; left unrenamed so existing references still resolve.                                                                                                                                                               |
| BEHAVIOUR.md: the Open onboarding line replaced by a Resolved line (BD41, L-UI1)                                            | Fixed by BD41; the walkthrough is now 21 steps.                                                                                                                                                                                                   |
| OPERATIONS.md: "once written" removed from the DEPLOYMENT cross-reference                                                   | DEPLOYMENT.md exists.                                                                                                                                                                                                                             |
| Status notes at the top of docs/01, 02 and 03 (bodies unchanged)                                                            | They still claim Mainnet defaults, a Walrus-authoritative rebuildable index, managed as the default and a JSON-RPC fallback; 03 section 19 lists A1 to A12 without current statuses. Pointers go to BD33, BD36, BD41, A4, A8, A26 and OPERATIONS. |
| SECURITY_REVIEW.md: two sweeps appended (A1 to A9 error-message paths, B1 to B8 fallbacks), nothing fixed                   | Requested as report-only. A1 (verification errors returned raw and unlogged) and A6 (job errors logged raw) fall outside the M5 fix.                                                                                                              |
| LOCAL_CHECKS.md: L-PG1 added (migrations 001 to 009 and row-level security on real Postgres 16 through scripts/db-smoke.ts) | Only 001 to 005 ran on real Postgres (L-A3). The migration chain can run through DATABASE_URL today; the isolation suite cannot (tests always build PGlite), so L-PG1 says what that would take instead of building it.                           |

## History moved out of HANDOFF.md

Moved here unchanged (headings demoted) when HANDOFF became current-state only.

### Changes since the audit (owner's go-ahead)

- Chain: gRPC only by default everywhere, including mock worlds and test rigs; JSON-RPC only when `TATUM_JSONRPC_URL` is set; env-level tests added. Architecture section 11 and decision record 4 updated.
- Architecture section 6 describes both idempotency layers. PROGRESS Step 0 status and route count fixed.
- LOCAL_CHECKS: the Step 0 docs check is now L-S0, so L-D1 is only the live demo.
- ASSUMPTIONS: A18 and A19 defined (reconstructed), A17 to A19 added to the register, statuses set.
- `.env.example` lists every variable the code reads; `REDIS_URL` removed.
- `pnpm dev:api` works on Windows shells (the dev server defaults `DASHBOARD_DIR`); `pnpm typecheck` no longer needs `pnpm` on PATH.
- Root `LICENSE` replaced with a per-package notice (needs a legal re-read).
- Hackathon framing removed from README, PROGRESS, LOCAL_CHECKS, ASSUMPTIONS, whitepaper, PRD, architecture, CLAUDE.md build order, the evidence report comments and the CLI test; `buiry evidence` is the storage and verification report.
- Remote branch `ccr-e0e1030c-5n01et` deleted after confirming it was an ancestor of `main`.
- History rewrite (approved): author and committer of the 15 AI-identity commits set to `ISAAC BENEDICT`; trees, messages and dates verified identical; force-pushed with lease. Local backup tag `backup-before-author-rewrite`.
- Checked: `packages/core`, `packages/mcp` and `packages/cli` each still have the Apache-2.0 `LICENSE` file (identical in all three), `"license": "Apache-2.0"` in `package.json`, and an `SPDX-License-Identifier: Apache-2.0` header in every `src/*.ts` file (26 files).
- Live signed Walrus calls (2026-11-10): signatures accepted; remember, bulk, restore and the listing pass; expiry read (L-W2). Recall returned `degraded` with candidates dropped; the adapter and the recall merge now handle that (served from the index, flagged), with regression tests (377 tests).

### Corrections made

- HANDOFF.md did not exist on disk or in git history; created from the pasted draft.
- Gate: replaced the reported counts with this session's run (33 files, 372 tests passing); noted that `pnpm typecheck` needs `pnpm` on PATH; marked the 344 cloud figure unverified and identified the commit now at `d7d2f7f` as `origin/ccr-e0e1030c-5n01et`.
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

### Bugs found only by live runs (fixed)

- Email sign-in link did not sign anyone in (token lost in the signed-out redirect).
- Built CLI and MCP `dist` imported unbuilt workspace source; now bundled.
- Windows: CLI exit code non-zero after successful network calls; fixtures path built with `new URL().pathname`.
- gRPC endpoint URLs are normalised to `host:443`; delegate key parsing accepts `suiprivkey1...`.
- LOCAL_CHECKS said to use `BUIRY_MAILER=memory` for CLI login, which makes email login impossible.
- Per-address rate limit on `/v1/auth/*` also counted signed-in endpoints; now only unauthenticated ones.
- Retries reusing a failed idempotency key: the fix is in code (`packages/storage/src/write-worker.ts` suffixes the relayer key with `.a<attempt>` on retries), but that it was found by a live run is unverified; it is not recorded in PROGRESS or LOCAL_CHECKS.

## Phase 1: design report (2026-11-18)

| File                                       | Why                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/design/00-index.md`                  | Contents, the five blocking decisions and what the owner should prepare.                                                                                                                                                                                                                                   |
| `docs/design/01-product-and-proof.md`      | Sections 1 to 4: product, honest limits, audiences, feature inventory with evidence levels, the proof table with publish status, and claims we must not make.                                                                                                                                              |
| `docs/design/02-dashboard-and-system.md`   | Sections 5 and 6: screen inventory, gap table and deliberate contradictions against the UI spec, weak screens, accessibility tested versus assumed, tokens and components, and computed WCAG contrast (script output pasted). Screens were captured on mock sample data into `.buiry-local/design-shots/`. |
| `docs/design/03-site-and-messaging.md`     | Sections 7 and 8: website map with calls to action that reflect tenancy, the blocked install and open-source blocks, messaging inputs (problems, candidate lines with their risks, proof points, objections, glossary, tone, words to avoid).                                                              |
| `docs/design/04-motion-assets-and-tech.md` | Sections 9 to 11: motion items with the story each must show accurately, the asset list with formats and budgets, the motion technology trade-offs, front-end constraints with measured bundle sizes (script output pasted), CSP, hosting and licences, and the reference-site checklist.                  |
| `docs/design/05-decisions-and-gaps.md`     | Sections 12 and 13: sixteen owner decisions with recommendations, method, what could not be checked, and thirteen contradictions with the source that wins.                                                                                                                                                |

## Phase 2: pre-exposure hardening (2026-11-18)

| Change                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 `mapChainError` rethrows non-chain errors so the HTTP handler answers `internal error` and logs the M5 line; failed jobs are recorded and logged by class and Postgres code (`describeJobError`, `jobFailureLine`), keeping the `[buiry] job <name> failed` text the alarm matches; sweep A re-run added to SECURITY_REVIEW | Sweep A1 returned raw messages (which can quote stored values) to clients unlogged; A6 logged raw job messages. The existing scheduler test now expects the class instead of the message.                                             |
| 2.2 Production startup requires `BUIRY_MANAGED_WORKSPACE_ID` or `BUIRY_MANAGED=off` and refuses `BUIRY_MANAGED_MULTI_TENANT=1`; `BUIRY_MANAGED=off` builds no shared account; Terraform `managed_workspace_id` (empty = off); DEPLOYMENT first-deploy steps; `.env.production.example`; BD42                                    | Sweep B1 and B2: an unnamed tenant let the first project creator claim the shared account, and multi-tenant mode exposes every tenant (A26). Two applies is the simplest bootstrap with no claim window. `terraform validate` passes. |
