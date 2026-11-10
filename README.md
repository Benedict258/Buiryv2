# Buiry

Portable, verifiable project memory for AI coding agents.

Agents connect over MCP, read a briefing for the task at hand, write typed memories with evidence, report whether a memory helped, and hand off to the next session or tool. Memory is stored on Walrus Memory, scored by a deterministic learning loop, checked against the chain through Tatum's Sui gateway, and governed from a dashboard.

Built for the Tatum x Walrus "Total Recall" hackathon.

## Quick start

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm demo                  # two-agent scenario on mocks, nothing external needed
pnpm conformance           # 30 checks over the MCP surface
```

Try the dashboard on mocks (real API and MCP endpoint, seeded sample project, prints a session token to paste on the sign-in page):

```bash
pnpm --filter @buiry/dashboard build
pnpm dev:api               # http://localhost:8787
```

Run the service (REST on `/v1`, MCP on `/mcp`; set `DASHBOARD_DIR=apps/dashboard/dist` to serve the dashboard too):

```bash
cp .env.example .env       # fill in values; never commit .env
pnpm tsx packages/worker/src/bin.ts
```

Connect a tool from a repository:

```bash
pnpm tsx packages/cli/src/bin.ts login --api http://localhost:8787 --email you@example.com
pnpm tsx packages/cli/src/bin.ts init --name my-project
pnpm tsx packages/cli/src/bin.ts connect claude-code
```

Anything that talks to Walrus or Tatum for real is described in [LOCAL_CHECKS.md](LOCAL_CHECKS.md). Assumptions about third-party behaviour are logged in [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md).

## Layout

| Path               | What                                                                     | Licence     |
| ------------------ | ------------------------------------------------------------------------ | ----------- |
| `packages/core`    | memory codec, namespaces, redaction, learning loop, briefing, BUIRY.md   | Apache-2.0  |
| `packages/mcp`     | MCP server (stdio and Streamable HTTP) and REST client backend           | Apache-2.0  |
| `packages/cli`     | `buiry` command line                                                     | Apache-2.0  |
| `packages/storage` | Walrus adapter, mock relayer, durable write queue and worker             | proprietary |
| `packages/chain`   | the single Tatum gateway, verifiers, mock Tatum                          | proprietary |
| `packages/api`     | Postgres schema, memory service, auth, REST API, SSE                     | proprietary |
| `packages/worker`  | scheduled jobs: write drain, drift, expiry, snapshots, canary            | proprietary |
| `apps/dashboard`   | web dashboard                                                            | proprietary |
| `scripts`          | conformance, demo, demo-memory writer, smoke tests                       | proprietary |
| `docs`             | whitepaper, PRD, architecture, UI spec, decisions, assumptions, progress | n/a         |

Architecture diagram source: [docs/diagrams/architecture.mmd](docs/diagrams/architecture.mmd). Blog outline: [docs/BLOG_OUTLINE.md](docs/BLOG_OUTLINE.md).

## Hackathon evidence

```bash
buiry evidence             # Walrus blob ids and expiry, Tatum call counts and transports
```

The same report is available at `GET /v1/projects/:id/evidence-report` and from the dashboard.

## Licensing

Licensing is per package (see the root `LICENSE` notice and `NOTICE`). `packages/core`, `packages/mcp` and `packages/cli` are Apache-2.0; everything else is proprietary. Each package's own `LICENSE` file applies.
