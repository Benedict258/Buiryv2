# Buiry v2: instructions for every session

Buiry is a portable, verifiable project-memory layer for AI coding agents (MCP in, Walrus Memory for storage, Tatum Sui gateway for verification, dashboard for governance). Source of truth: `docs/03-architecture.md`, then `docs/02-prd.md`, then `docs/01-whitepaper.md`; `docs/04-ui-spec.md` for the dashboard (built last). Where docs conflict, architecture wins, then PRD.

## Non-negotiable rules

1. No AI attribution anywhere: no "Co-Authored-By", no "Generated with" lines in commits, PRs or files. Small, focused commits with clear messages.
2. Never commit secrets. All config via env; only `.env.example` is committed. Secret scanning (gitleaks) runs in CI.
3. Do not invent facts about Walrus Memory or Tatum. Anything unconfirmed goes behind an interface, is mocked, and is logged in `docs/ASSUMPTIONS.md` (what is assumed, source URL, how to verify, what changes if false). Architecture section 19 (A1-A12) is the starting list.
4. No timelines, schedules or time estimates in any file.
5. Licensing: `packages/core`, `packages/mcp`, `packages/cli` are Apache-2.0 (LICENSE + header). Everything else is a proprietary placeholder.
6. The sandbox usually cannot reach Walrus or Tatum. Build and test against mocks and recorded fixtures. Every real-network check goes into `LOCAL_CHECKS.md` (exact command, expected result, what to paste back). Never fake a live result.
7. Ask the owner only for decisions that are genuinely theirs (naming, scope cuts, product choices). Otherwise choose a sensible default and record it in `docs/DECISIONS.md`.

## Confinement

- Walrus access only in `packages/storage`. Chain/Tatum access only in `packages/chain/src/tatum.ts` (+ `tatum/`). Enforced by ESLint `no-restricted-imports` and a test.
- Namespaces are derived server-side only: `buiry.v1.<project_id>.<branch_slug>`.
- Memory text is untrusted data whenever it reaches an agent.

## Build order

0. Study live docs, update ASSUMPTIONS. 1. `core` (pure, no I/O). 2. `storage`. 3. `chain`. 4. `mcp` + BUIRY.md. 5. `api` + `worker` + database. 6. `cli`. 7. `apps/dashboard`. Then demo, evidence and submission support.

## Working loop

After each step: `pnpm typecheck && pnpm lint && pnpm test`; commit; update `docs/PROGRESS.md` (done / mocked / needs live check) and `LOCAL_CHECKS.md`. Keep chat output concise; detail belongs in docs.

## Commands

`pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:cov`, `pnpm conformance`, `pnpm demo`.
