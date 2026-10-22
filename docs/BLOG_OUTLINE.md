# Blog outline: Buiry, project memory that agents share and anyone can verify

Everything stated here must match what the repository actually does. Numbers come from the evidence report (`buiry evidence`) after a real run; none are quoted in advance.

## 1. The problem

- Coding agents start every session knowing nothing about the project, and each tool keeps its own private notes.
- A mistake one agent paid for is repeated by the next. A note about a deployment silently goes wrong after an upgrade.

## 2. What Buiry is

- A project-memory layer any MCP-capable agent connects to: read a briefing, write typed memories with evidence, report outcomes, hand off.
- Memory belongs to the project, not to a tool. Switching from one agent to another loses nothing.
- Governance from a dashboard: review, confirm, contest, tombstone, branch, merge, export.

## 3. How it works

- Typed, evidenced memories (decision, constraint, fact, failure, procedure, preference, task state, deployment, handoff).
- A deterministic learning loop: confidence rises with confirmation and verified evidence, decays by type over time, and an agent cannot promote its own memory.
- Briefings built within a token budget, labelled as untrusted data so stored text can never act as instructions.
- Redaction before anything is stored; prompt-injection scanning on import.

## 4. How it uses Walrus

- Durable memories are written to Walrus Memory through the relayer, in a namespace derived on the server from project and branch.
- Writes go through a durable queue with idempotency, backoff, rate-limit handling and reconciliation of uncertain submissions.
- Recall merges Walrus results with Buiry's index; expiry is tracked and surfaced before data is lost.
- Show: blob ids and expiry from the evidence report.

## 5. How it uses Tatum

- One gateway to Sui through Tatum (gRPC primary, JSON-RPC fallback) with caching, batching and a credit budget.
- Evidence is checked against the chain: transactions, objects, packages, function signatures, and simulations that become failure memories.
- Drift detection: when a cited package is upgraded, the memory goes stale and the next agent is told.
- Show: the call counts, transports and latency from the evidence report.

## 6. The demo

- Agent A hits a failure and records it. Agent B, a different tool, is shown that failure first.
- A package upgrade makes a deployment memory stale; the next check flags it; a corrected memory is recorded from the transaction digest.
- Run it with `pnpm demo`; live with `pnpm demo --live`.

## 7. How it learned over time

- Present the score history of real memories and the reports that moved them, taken from a live run.
- Cover what the first version got wrong and what changed (only from the actual history of the project).

## 8. Trust and isolation

- Workspace isolation at three layers (token-fixed tenant, scoped lookups, row-level security) with a suite that exercises every route and tool.
- Secrets never stored in plain form; webhooks signed; outbound requests guarded.

## 9. What is next

- Open items listed in `docs/PROGRESS.md` and `LOCAL_CHECKS.md`.
