# Buiry PRD

Oct 11, 2026 · @Benedict Isaac

## 1. Document control and summary

| Field | Value |
| --- | --- |
| Product | Buiry (rebuilt from scratch) |
| Document | Product Requirements Document, version 1.0 |
| Status | Draft for review |
| Companion documents | Buiry Whitepaper; Buiry Architecture and System Design; Buiry UI Spec |
| Conventions | Requirement IDs are stable (FR-, NFR-). Priority: **Must** (product is not Buiry without it), **Should** (expected for a credible product), **Could** (valuable extension). No dates are assigned; order follows dependency. |
| Verification markers | **\[VERIFY\]** marks a requirement that depends on a third-party behaviour not yet confirmed. See section 16. |

**Summary.** Buiry is a portable, verifiable project-memory platform for AI coding agents. Agents connect over MCP, read a briefing about the project, write typed memories with evidence, report outcomes, and hand off between sessions. Memory is stored on Walrus Memory (Mainnet), scored by a deterministic learning loop, verified through Tatum where it depends on chain state, and governed from a dashboard. Switching tools must not lose project knowledge: installing Buiry in a new agent finds the existing project memory and continues from it.

Buiry is built from scratch. The previous codebase was studied only to learn from it and is not reused.

## 2. Problem, goals and non-goals

**Problem.** Agents forget between sessions, memory is trapped inside the tool that created it, remembered facts silently go stale, and nobody can audit where a memory came from. Developers who use more than one agent, and teams whose members use different agents, repeatedly re-explain their project.

**Goals**

- **G1. Portability:** a project's memory is usable from any MCP-capable agent, on any machine, by any authorised member.
- **G2. Continuity:** a newly attached agent identifies the project, finds the existing memory, and is briefed without manual re-explanation.
- **G3. Trust:** every memory carries provenance and evidence, and confidence that rises and falls deterministically.
- **G4. Two-way communication:** agents talk to Buiry, and Buiry tells agents when memory is stale, contested or relevant.
- **G5. Verification:** chain-dependent and repository-dependent claims are checked against reality.
- **G6. Visibility and control:** humans can see, search, confirm, contest, replay and govern memory in a dashboard.
- **G7. Persistence honesty:** expiry and renewal of stored memory are visible and managed.
- **G8. A real product:** teams, branches, billing, an API and integrations, not only a demo.

**Non-goals**

- Not a chat-history store or general knowledge base.
- Not a coding agent and not an agent orchestrator.
- No guarantee that an agent obeys the briefing.
- No claim of privacy from the relayer operator in managed mode.
- No model required in the core path; model-assisted features are optional.
- No reuse of the previous Buiry codebase or its Sui marketplace contracts.

## 3. Users, personas and jobs to be done

The target user is a general developer. Chain-dependent verification is an additional benefit for developers who work on Sui or other chains, not a prerequisite.

| Persona | Description | Primary needs |
| --- | --- | --- |
| P1. Multi-agent solo developer | One developer, one or more repositories, two or more agents (for example Claude Code and OpenCode) | Keep context when switching tools; stop agents repeating mistakes; see what agents wrote |
| P2. Team lead or small team | A few developers on one repository, each with a preferred agent | Shared project knowledge; avoid conflicting agent decisions; roles; audit |
| P3. Chain builder | Developer deploying contracts or apps on Sui or another chain | Agents stop using stale package or object IDs; deployments recorded with proof; failed simulations remembered |
| P4. Integrator or maintainer | Builds tooling or maintains a project with many contributors | API, webhooks, alerts into Slack or Discord, memory packs for onboarding |
| P5. Evaluator or reviewer | Reads a project's public showcase page | Confidence the memory is real, onchain, and healthy |

**Jobs to be done**

1. When I switch from one agent to another, I want the new one to already know my project, so I do not re-explain it.
2. When an agent is about to repeat something that failed before, I want it warned, so I do not waste another session.
3. When something an agent remembers has become false, I want it flagged before it acts on it.
4. When an agent writes something into project memory, I want to see who wrote it and on what evidence, and to approve or reject it.
5. When a teammate joins, I want to hand them the project's accumulated knowledge in one step.
6. When I deploy something, I want its identifiers recorded with proof, not typed from an agent's recollection.
7. When stored memory is about to expire, I want to be told and, where possible, have it renewed.

## 4. Product principles and decisions locked

**Principles:** the project owns the memory; memory is evidence not assertion; trust is earned and can be lost; failures are first-class; the system can talk back; verify against reality; deterministic by default; honest about guarantees; open at the edges.

**Decisions locked** (from the product discussions; the decision log in section 17 lists the rationale):

| # | Decision |
| --- | --- |
| D1 | Start from scratch: new repository, dashboard, backend, schema. The old repository is a lesson only. |
| D2 | Target user: general developers. |
| D3 | Agent protocol: MCP primary. Buiry can talk back through a check tool and a generated project file; MCP notifications are a bonus. |
| D4 | Each project has a `BUIRY.md` file with project rules, an identifier and a briefing snapshot. |
| D5 | Storage: Walrus Memory on Mainnet is authoritative for memory content. |
| D6 | Chain verification through Tatum, all reads through one gateway module. |
| D7 | Memory types and the learning loop are deterministic; any model use is optional, bring-your-own-key, off by default and visible. |
| D8 | Dashboard shows live memory, an activity log of every call, write and edit, and alerts. Alerts go to the dashboard first, then optionally to platforms through webhooks. |
| D9 | Login: wallet, email, GitHub and Google. |
| D10 | Compatible with all MCP-capable agents; Claude Code, OpenCode and Cursor are examples, not the list. |
| D11 | Branches and multiple teams on one project. |
| D12 | Open-core: client pieces open source, hosted platform paid. |
| D13 | Monetisation approved in principle: free, pro, team and enterprise tiers, usage add-ons, memory packs, payments through Sui and third-party providers. Prices open. |
| D14 | Hosting: any suitable provider. |
| D15 | Walrus Memory, not Walrus Console, is used for memory. Console may later serve large artifacts such as pack exports. |
| D16 | Account model: operator account with a namespace per project in managed mode; bring-your-own account and self-hosted relayer as options. |
| D17 | Features approved: proposed versus confirmed memory, redaction before write, prompt-injection guardrails, handoff notes, roles, token-budget-aware briefings, replay, memory packs, public showcase page. |

## 5. Capability map and scope

The full product is in scope. The map groups capabilities; each group has requirements in sections 6 to 8. Order of building follows dependency: identity and the write path come before scoring; scoring before verification-driven flags; single-user before teams.

| Area | Capability | Depends on |
| --- | --- | --- |
| A. Identity and tenancy | Accounts, login methods, workspaces, roles, projects, agent tokens | none |
| B. Agent connection | MCP server, connect, briefing, remember, recall, report, handoff, check, onboarding of a new tool | A |
| C. Memory core | Typed events, statuses, evidence, redaction, write queue, idempotency | A, Walrus |
| D. Learning loop | Confidence, decay, contradiction, failure memory, proposed versus confirmed | C |
| E. Push-back | Briefing file generation, check tool, alerts to dashboard, webhooks, notifications | B, D |
| F. Verification | Tatum gateway, evidence verifiers, drift, simulation capture, repository evidence | C, D |
| G. Storage health | Expiry monitoring, renewal, relayer health, account and delegate audit | C, F |
| H. Collaboration | Branches, merges, handoffs, replay, concurrent agent handling | C, D |
| I. Dashboard | Projects, memory explorer, detail, timeline, agents, activity log, alerts, verification, handoffs, briefing preview | A to H |
| J. Platform | REST API, webhooks, CLI, memory packs, public showcase | A to H |
| K. Commercial | Plans, entitlements, usage metering, billing, payment rails | A, J |
| L. Operations | Observability, backups, relayer modes, admin tools, security controls | all |

## 6. Functional requirements, part 1: identity, projects, agents, MCP

### A. Accounts, login and tenancy

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-A1 | Users can sign up and log in with a Sui wallet, email, GitHub or Google. | Must |
| FR-A2 | A user's login identity is separate from any Walrus account ownership. Linking a Sui address (wallet, or Google through zkLogin where supported) is a distinct, optional step. **\[VERIFY\]** which logins can own a Walrus account directly. | Must |
| FR-A3 | A workspace contains members, projects, agents, billing and settings. A user can belong to several workspaces. | Must |
| FR-A4 | Roles: owner, admin, writer, reader, with the permission matrix in the Architecture document. | Must |
| FR-A5 | Email and GitHub sign-in create a Buiry-managed identity; wallet users keep their address as identity. | Must |
| FR-A6 | Sessions, device list, sign-out everywhere, and account deletion with data export. | Should |
| FR-A7 | Invitations by email or link, with role selection and expiry. | Should |
| FR-A8 | Single sign-on for enterprise workspaces. | Could |

### B. Projects and BUIRY.md

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-P1 | A project has a stable ID, name, description, declared networks (for example Sui mainnet), a default branch `main`, and settings. | Must |
| FR-P2 | `buiry init` creates the project (or links an existing one) and writes `BUIRY.md` containing the project ID, rules, agent instructions and a briefing snapshot between markers. It never writes secrets. | Must |
| FR-P3 | `BUIRY.md` is the primary identification mechanism. If absent, Buiry offers a repository-remote fingerprint match and requires user confirmation. | Must |
| FR-P4 | Human-edited regions of `BUIRY.md` are preserved when Buiry regenerates the snapshot region. | Must |
| FR-P5 | Buiry can generate or patch tool-specific context files (for example `CLAUDE.md`, `AGENTS.md`, Cursor rules) that point to `BUIRY.md`. | Should |
| FR-P6 | Projects can be archived, transferred between workspaces, and deleted (tombstone all memories; permanent blob deletion is separate and owner-signed). | Should |
| FR-P7 | Per-project settings: confidence thresholds, auto-promotion rules, retention and renewal margin, redaction rules, allowed evidence types. | Should |

### C. Agents and connections

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-G1 | Each agent connection has its own Buiry token scoped to one project (or workspace), a name, the tool type, and permissions (read, write, confirm). | Must |
| FR-G2 | Every memory records the agent, tool, session and branch that produced it. | Must |
| FR-G3 | Tokens can be revoked instantly; revoked agents are rejected and the event is logged. | Must |
| FR-G4 | `buiry connect` configures a supported tool (writes its MCP entry) with one command and verifies the connection. | Must |
| FR-G5 | On first connection from a new agent to a project that already has memory, Buiry reports what it found and sends an onboarding briefing. | Must |
| FR-G6 | In bring-your-own-account mode, an agent can hold its own Walrus delegate key; Buiry records the delegate identity. | Could |
| FR-G7 | Per-agent rate limits and quotas with clear error messages. | Should |

### D. MCP server tools

The MCP tool set is specified in section 17. Behaviour requirements:

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-M1 | The MCP server supports stdio and Streamable HTTP transports. | Must |
| FR-M2 | `buiry_connect` identifies the project and returns project metadata, memory counts, last activity, and the active branch. | Must |
| FR-M3 | `buiry_check` returns the briefing and any flags, fitted to a token budget supplied by the caller. | Must |
| FR-M4 | `buiry_remember` returns immediately with a memory ID and a durability state (`queued`, `stored`, `failed`), not blocking on the Walrus write. | Must |
| FR-M5 | `buiry_recall` supports query, type, status, branch and limit, returns confidence and flags, and labels content as untrusted data. | Must |
| FR-M6 | `buiry_report` records whether a recalled memory helped, was wrong, or was irrelevant. | Must |
| FR-M7 | `buiry_handoff` writes a structured end-of-session summary. | Must |
| FR-M8 | Tools are idempotent where a retry may occur; duplicate writes from client reconnects are suppressed. | Must |
| FR-M9 | Tool descriptions are written so agents use them proactively, and the generated project file includes explicit instructions to call `buiry_check` at session start and `buiry_handoff` at the end. | Must |
| FR-M10 | The server degrades gracefully: if Walrus or the verification gateway is unavailable, reads continue from the index and writes queue. | Must |

## 7. Functional requirements, part 2: memory, learning loop, push-back, branches

### E. Memory core

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-C1 | Memory types: decision, constraint, fact, failure, procedure, preference, task\_state, deployment, handoff. | Must |
| FR-C2 | Memories are event-sourced and append-only. State changes are events (created, confirmed, reported, contested, superseded, validated, stale, tombstoned, snapshot). State-defining events are durable and written to storage; high-volume signals (reports, routine verification passes, recalls) are kept locally and summarised in periodic snapshot events. Current state is derived. | Must |
| FR-C3 | Each memory event is encoded in the stored text with a short machine header (event, ID, type, branch, agent) followed by natural language, so that Buiry's index can be rebuilt from the stored record. | Must |
| FR-C4 | Evidence types: transaction digest, object ID and version, package ID, file path with commit, link, test result. A memory may carry several. | Must |
| FR-C5 | Redaction runs before every write: credentials, tokens, private keys, seed phrases, authorisation headers, URLs with embedded credentials, and configurable patterns. Redaction results are reported to the writer. | Must |
| FR-C6 | Writes go through a durable queue with retry and backoff, idempotency keys, and per-write state visible in the activity log. | Must |
| FR-C7 | Write-rate budgets per agent and per project to bound cost; over-budget writes are summarised or rejected with an explanation. | Should |
| FR-C8 | Duplicate or near-duplicate memories are detected on write and linked or merged by proposal, since the storage layer does not deduplicate. | Should |
| FR-C9 | Memory text length limits and chunking guidance; large content is stored as a summary with a reference. | Should |
| FR-C10 | Recall merges semantic similarity with Buiry's confidence, status and recency, and never returns tombstoned or superseded memories by default. | Must |

### F. Learning loop

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-L1 | Agent-written memories start `proposed` with low confidence. Human confirmation, or the project's auto-promotion rule, makes them `confirmed`. | Must |
| FR-L2 | Confidence rises on confirmation, successful reuse reports and passed verification, and falls on contradiction, wrong or unhelpful reports, drift and age. Weights are project-configurable defaults. | Must |
| FR-L3 | Conflict detection compares a new memory with similar existing ones and returns them to the writer as conflict candidates, asking for an explicit relation (supersedes, distinct, agrees). A memory becomes contested only on an explicit contest, repeated wrong reports or a failed verification. Resolution is explicit: supersede, confirm both for different branches, or tombstone. | Must |
| FR-L4 | Failure memories are surfaced in briefings and recall results ahead of related decisions, and flagged when an agent starts a task similar to a recorded failure. | Must |
| FR-L5 | Time decay is per memory type (for example task\_state decays quickly, constraint slowly). | Should |
| FR-L6 | Optional model-assisted judge and briefing compactor: bring your own key, off by default, every call logged with inputs and outputs and shown in the dashboard. | Could |
| FR-L7 | The score history of any memory is viewable, with the reason for each change. | Should |

### G. Push-back and alerts

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-B1 | `buiry_check` returns stale, contested and expiring items relevant to the current task, plus new events since the agent's last check. | Must |
| FR-B2 | Buiry regenerates the briefing snapshot region of `BUIRY.md` when material state changes, so that agents that never call tools still get an up-to-date briefing from the file. | Must |
| FR-B3 | Alerts appear in the dashboard with severity, cause and the affected memories and agents. | Must |
| FR-B4 | Webhook delivery to Slack, Discord and generic HTTPS endpoints with signing, retries and a delivery log. | Should |
| FR-B5 | Where a client supports MCP notifications, Buiry sends them as a bonus channel; behaviour never depends on them. | Could |
| FR-B6 | Alert rules are configurable per project: which events, which severity, which channel. | Should |
| FR-B7 | Alert fatigue controls: grouping, quiet hours, and acknowledgement. | Should |

### H. Branches, teams and handoffs

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-H1 | A project has branches. `main` is protected by default: only confirmed memories and merges write there. | Must |
| FR-H2 | Each branch maps to its own Walrus namespace. Recall on a branch reads that branch and `main`. | Must |
| FR-H3 | Merging writes supersede and confirm events into the target branch and preserves lineage. Conflicts are surfaced for resolution. | Must |
| FR-H4 | Concurrent writes from several agents never overwrite each other; conflicts become contested memories. | Must |
| FR-H5 | A handoff records done, blocked, next, memories relied on, and open questions, and is delivered in the next briefing. | Must |
| FR-H6 | Replay: the dashboard can show project state, and what each agent was shown, at any past moment. | Should |
| FR-H7 | Branch-aware permissions: members can be limited to specific branches. | Could |

## 8. Functional requirements, part 3: verification, storage, dashboard, CLI, platform

### I. Verification (Tatum)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-V1 | All chain reads, simulations and lookups go through one gateway module that talks to Tatum's Sui gateway with the API key held server-side. | Must |
| FR-V2 | Transports: gRPC only by default; the JSON-RPC backend is used only when explicitly configured, because Tatum does not serve Sui JSON-RPC (A8). Each call records transport, latency, status and credit estimate. | Must |
| FR-V3 | Evidence-backed deployments: given a transaction digest, Buiry reads the transaction, extracts created and changed packages and objects, and stores them as the deployment memory's evidence. | Must |
| FR-V4 | Drift detection: memories citing object IDs or packages are re-checked on schedule, on demand and at check time; version or upgrade differences mark them stale and lower confidence. | Must |
| FR-V5 | Simulation capture: a drafted transaction can be dry-run and a failed result is stored as a failure memory. | Should |
| FR-V6 | Network sanity: identifiers are checked against the project's declared networks and mismatches flagged. | Should |
| FR-V7 | Verification budget: caching, batching and a per-workspace credit budget so the free Tatum plan is not exhausted; throttling and clear messages when exhausted. | Must |
| FR-V8 | Repository evidence: memories citing file paths and commits are flagged when the files change. | Should |
| FR-V9 | Pluggable verifier interface with a minimal EVM verifier (contract code present, transaction status). | Could |
| FR-V10 | Name resolution for addresses shown in the dashboard. | Could |
| FR-V11 | A live panel shows gateway status, transport mix, latency and credit use. | Must |

### J. Storage and persistence (Walrus)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-S1 | Memories are written to Walrus Memory on Mainnet through a configurable relayer URL; switching relayers is configuration only. | Must |
| FR-S2 | Managed mode: an operator account with a namespace per project and branch, derived server-side. | Must |
| FR-S3 | Bring-your-own-account mode: the user owns the account and Buiry holds a revocable delegate key. | Should |
| FR-S4 | Self-hosted relayer mode with configurable limits and epoch counts. | Could |
| FR-S5 | Expiry monitoring: each memory's end epoch and expiry time are read and shown; alerts fire with a margin larger than the check interval. | Must |
| FR-S6 | Renewal: expiring memories are renewed where ownership permits. **\[VERIFY\]** blob ownership and relayer behaviour; until resolved, show expiry and alert without promising renewal. | Must |
| FR-S7 | Storage health: relayer reachability and write state, wallet balances (self-hosted), account delegates, quota use. | Must |
| FR-S8 | Index rebuild from Walrus for a project or workspace. **\[VERIFY\]** the interface for retrieving text for enumerated blobs. | Must |
| FR-S9 | Deletion distinguishes tombstone, index removal and permanent blob deletion; permanent deletion requires an owner signature and is offered only where available. **\[VERIFY\]** | Should |
| FR-S10 | Verifiable references: each memory shows its Walrus blob ID and a link to the onchain account. | Should |

### K. Dashboard

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-D1 | Project list and project overview with health, recent activity, counts by type and status, flagged items and expiry summary. | Must |
| FR-D2 | Memory explorer: search, filter by type, status, branch, agent, confidence, evidence and expiry; sort; bulk actions. | Must |
| FR-D3 | Memory detail: text, type, status, confidence history, evidence with verification results, lineage (supersedes and superseded by), provenance, storage reference, and actions (confirm, contest, supersede, tombstone). | Must |
| FR-D4 | Live updates: memories and events appear as agents write. | Must |
| FR-D5 | Activity log of every call, write, edit, recall, verification and alert, with agent, latency, result and links to affected memories. | Must |
| FR-D6 | Agents view: connected agents, tools, last seen, usage, token management and revocation. | Must |
| FR-D7 | Alerts and flags view with acknowledgement and resolution. | Must |
| FR-D8 | Branches view with merge flow and conflict resolution. | Must |
| FR-D9 | Timeline and replay view. | Should |
| FR-D10 | Briefing preview: what an agent would receive for a given task and token budget. | Should |
| FR-D11 | Handoffs view. | Should |
| FR-D12 | Verification panel: evidence status, gateway health, Tatum usage. | Must |
| FR-D13 | Team, roles, invitations, settings, integrations, billing, and a storage health view. | Must |
| FR-D14 | Memory packs: export, import, preview before import. | Should |
| FR-D15 | Public showcase page per project, opt-in, read-only, with onchain proof links. | Could |

### L. CLI, API and integrations

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-K1 | CLI commands: init, connect, login, status, doctor, briefing, remember, recall, export, import. | Must |
| FR-K2 | `buiry doctor` diagnoses MCP connection, token, relayer, gateway and project file. | Must |
| FR-X1 | REST API with project-scoped tokens: read memories, post events, list alerts, manage agents. | Should |
| FR-X2 | Signed webhooks with a delivery log and replay. | Should |
| FR-X3 | Fallback path for tools without MCP: REST API plus generated context files. | Should |
| FR-X4 | OpenAPI specification and a TypeScript client. | Could |

### M. Commercial and operations

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-Z1 | Plans with entitlements: projects, memories, history, alerts, seats, branches, replay. | Should |
| FR-Z2 | Usage metering for writes, recalls, verification credits and storage. | Should |
| FR-Z3 | Payments through providers available to the operator: Sui-native payments verified through the gateway, and third-party card or bank providers. **\[VERIFY\]** | Should |
| FR-O1 | Admin console for support: workspace lookup, relayer and queue health, feature flags. | Should |
| FR-O2 | Audit log for administrative actions and for deletion events. | Should |

## 9. Non-functional requirements

Targets are initial proposals to validate by measurement, not commitments.

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-1 | Latency | `buiry_remember` acknowledges within 500 ms at the 95th percentile (queue accept, not storage). `buiry_check` returns within 2 s at p95 from the index. `buiry_recall` returns within 5 s at p95; the relayer's own recall deadline is about 14 s and recall includes storage download and decryption. |
| NFR-2 | Durability | A write accepted into the queue is retried until it reaches a terminal state; no accepted write is silently lost. |
| NFR-3 | Availability | Reads continue from the index when Walrus or the gateway is degraded; the managed relayer carries no uptime guarantee, so Buiry must not present stronger guarantees than it can keep. |
| NFR-4 | Consistency | Eventual between a write and its appearance in recall (storage jobs are asynchronous and the vector index may lag). The UI and tools expose write state. |
| NFR-5 | Idempotency | Retries, reconnects and duplicate deliveries never create duplicate memories. |
| NFR-6 | Security | Tenant isolation enforced server-side; secrets never stored; tokens hashed; least privilege; signed webhooks; audit log. |
| NFR-7 | Privacy | The trust boundary of each custody mode is stated in the product. Redaction is on by default. |
| NFR-8 | Scalability | Designed for many projects per workspace and many agents per project; limits of the managed relayer (per-account request and storage limits) are respected with budgets and queues. |
| NFR-9 | Observability | Structured logs, metrics, traces and a per-request ID; user-visible activity log; internal dashboards for queue depth, relayer health and gateway health. |
| NFR-10 | Compatibility | Works with any MCP-capable client; conformance tests for each supported client. |
| NFR-11 | Accessibility | Dashboard meets WCAG 2.1 AA for contrast, keyboard use and screen readers. |
| NFR-12 | Portability | Export of all project data in an open format at any time; no lock-in to Buiry's index. |
| NFR-13 | Cost control | Per-agent and per-project budgets for writes and verification credits; visible usage. |
| NFR-14 | Maintainability | Open-source client pieces with documented protocol and versioned schema; schema migrations are backward compatible. |
| NFR-15 | Resilience to dependency change | Relayer URL, package ID and transports are configuration; third-party API changes are isolated behind adapters. |

## 10. End-to-end user flows

### Flow 1. First-time setup (solo developer)

1. Sign up with a wallet, Google, GitHub or email. Choose or create a workspace.
2. Run `buiry init` in the repository. Buiry creates the project, writes `BUIRY.md`, and shows the project in the dashboard.
3. Run `buiry connect` for the first agent (for example Claude Code). Buiry writes the MCP entry, issues an agent token, and runs a connection test.
4. Start a session. The agent calls `buiry_connect`, then `buiry_check`, and receives an empty-project briefing with usage instructions.
5. The agent writes memories during work. They appear in the dashboard live as `proposed`.

### Flow 2. Switching tools (the main goal)

1. The developer installs Buiry in a second agent (for example OpenCode) with `buiry connect`.
2. The agent calls `buiry_connect`. Buiry identifies the project from `BUIRY.md`, and reports: "Existing memory found: N memories, last written by claude-code on a given date."
3. Buiry sends an onboarding briefing: current state, confirmed decisions and constraints, failures to avoid, contested or stale items, open threads and the last handoff.
4. The agent continues the work. Its writes carry its own identity.

### Flow 3. Learning across sessions

1. In session one, an agent attempts an approach that fails and reports it. Buiry stores a failure memory.
2. In session two, possibly in another tool, the check tool places that failure at the top of the briefing for related work.
3. The agent avoids the approach; the developer sees in the activity log that the failure was shown and heeded.

### Flow 4. Drift caught

1. A deployment memory cites a package and an object version.
2. The package is upgraded. A scheduled or on-demand verification detects the difference.
3. The memory becomes `stale`, confidence falls, an alert appears in the dashboard, optionally in Slack.
4. At the next check, the agent is told, and re-records the deployment from the new transaction digest as evidence.

### Flow 5. Review and promotion

1. The developer opens the dashboard, filters `proposed` memories, reads provenance and evidence.
2. Confirms, contests or supersedes each. Confidence updates and the briefing snapshot regenerates.

### Flow 6. Team and branches

1. An admin invites teammates with roles. Each connects their own agent.
2. A teammate works on a feature branch. Their memories are written to the branch namespace.
3. On merge, confirmed branch memories are written into `main`; conflicts are shown for resolution.

### Flow 7. Expiry

1. The storage health view shows memories approaching expiry.
2. Buiry renews them where ownership permits, or alerts the owner with the affected memories and the deadline.

### Flow 8. Export and import

1. Export a memory pack from a project. Preview and import it into another project or hand it to a new teammate.

## 11. Integrations: Walrus Memory and Tatum

Facts below come from public documentation read on 2026-10-11 and are inputs to requirements, not guarantees.

### Walrus Memory

| Topic | What the documentation says | Consequence for the product |
| --- | --- | --- |
| Memory space | Identified by owner address, namespace (exact match, up to 255 UTF-8 bytes) and the Memory package ID | Branches and projects are namespaces; no hierarchy or tags |
| Accounts and delegates | One MemWalAccount per Sui address; delegate keys are registered onchain; a delegate can read and write all namespaces under the account | Managed mode isolation is Buiry's authorisation; owner key kept offline |
| Writes | Asynchronous jobs; `remember` returns a job ID; bulk writes up to 20; no deduplication; no built-in retry | Durable queue and idempotency in Buiry |
| Recall | Semantic; limit default 10, capped at 100; optional recency sort and scoring weights; read-after-write may lag | Buiry merges its own confidence and status |
| Enumeration | Memory Read API lists memories (metadata including blob ID, agent ID, status, end epoch, expiry) with cursors; namespace listing and per-namespace stats exist | Expiry monitoring and index rebuild support. **\[VERIFY\]** third-party use |
| Rate limits (public relayer) | 60 weighted requests per minute and 500 per hour per account; 30 per minute per delegate key; 1 GB storage per account | Budgets, queue, and a path to self-hosting |
| Availability | Public relayer provided as a public good without SLA | Graceful degradation; configurable relayer URL |
| Trust | Relayer sees plaintext in the default path; client-managed and self-hosted options exist | Stated in the product |
| Storage lifetime | Paid epochs (about two weeks each on Mainnet); conflicting default epoch counts; cap of 15; lapsed blobs unrecoverable | Expiry is a first-class feature. **\[VERIFY\]** |
| Deletion | Owner-signed permanent deletion (dashboard and API); index-only forget | Three distinct delete operations. **\[VERIFY\]** coverage |
| MCP behaviour | Memory tool writes return at acceptance by default; reconnects on Streamable HTTP can replay writes | Buiry's own idempotency |
| Self-hosting | A relayer can use the existing Mainnet package ID; requires database with vectors, Redis, a funded wallet and an embeddings key; reference implementation is Apache-2.0 | Option for scale and trust control |

### Tatum

| Topic | What the documentation says | Consequence for the product |
| --- | --- | --- |
| Sui endpoints | Mainnet JSON-RPC and gRPC; testnet and devnet gRPC; API key in a header | Gateway supports both on mainnet; testnet through gRPC |
| Deprecation | Sui has deprecated JSON-RPC in favour of gRPC | gRPC only by default (Tatum's Sui JSON-RPC returned 404 live, A8) |
| Services | Ledger, state, package, name, simulation, execution and checkpoint subscription services | Used by the verification requirements |
| Tier | Sui is listed in the tier without uptime guarantees | Caching and graceful degradation |
| Plan | Free plan: 100,000 credits, 3 requests per second, 2 API keys | Verification budget and throttling |
| Pricing | gRPC calls and streamed messages cost 2 credits each; first request and response free | On-demand verification, no full checkpoint streaming |
| Notifications | Supported chains list EVM chains, Tron, Tezos, Solana, XRP and Bitcoin-family chains; Sui is not listed | Sui verification by reads, not webhooks |

## 12. Success metrics

Metrics are defined so they can be measured from Buiry's own data. Targets are left open until baselines exist.

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Activation | Share of new projects where a second agent connects to existing memory | Tests the main goal, portability |
| Briefing use | Share of sessions that call `buiry_check` or read the briefing file | Tests whether agents use the memory |
| Reuse rate | Share of recalled memories with a positive report | Tests usefulness |
| Repeated-failure rate | Frequency of an agent re-attempting an approach that has a recorded failure | Tests the learning loop |
| Stale-caught rate | Share of drift events detected before an agent acted on the stale memory | Tests verification |
| Confirmation latency | Time from proposed to confirmed or rejected | Tests human governance load |
| Write durability | Share of accepted writes reaching `stored` | Tests reliability |
| Expiry losses | Memories lapsed without renewal or alert | Must be zero |
| Weekly active projects | Projects with at least one session in a week | Growth |
| Time to second agent | Minutes from first project to second-tool continuation | Onboarding quality |

A reproducible evaluation script should compare the same task run with no memory, with memory after one session and with memory after several sessions, measuring repeated mistakes, tool calls and time to a correct result. Agent runs vary, so each condition is repeated and averaged.

## 13. Monetization and packaging

Approved in principle; numbers are open.

| Tier | Audience | Entitlement dimensions (values open) |
| --- | --- | --- |
| Free | Individuals | Projects, memories, history window, agents, community support |
| Pro | Individual power users | More projects and history, alerts and webhooks, replay, memory packs |
| Team | Teams | Seats, roles, branches, audit log, shared projects |
| Enterprise | Organisations | Single sign-on, self-hosted relayer support, data residency, support terms |

Usage add-ons: storage and recall volume, verification credits, additional agents. Later: a marketplace of memory packs and templates.

Payment rails: Sui-native payments verified through the gateway, third-party providers, and conventional card or bank processors; provider availability for the operator's country to be confirmed. A unit-economics model (Walrus writes in storage and gas, embeddings, relayer and database, verification credits) must precede pricing.

## 14. Prototype acceptance and demo scenario

The prototype is working when:

- Walrus Memory is integrated and a signed write on Mainnet is stored, recalled and its expiry read back.
- Memories that must stay readable to a chosen date are written so that none lapses before it (see FR-S5 and the epoch caveat).
- Chain data is read through the single gateway module, with a visible usage panel.
- The demo below runs against real services, and the storage and verification report shows real blob IDs and expiries.

**Demo narrative.** Two different agents on one repository. Session one hits a trap and records a failure. Session two, in the other tool, is shown that failure first and avoids it. A deployed package is upgraded and the stale memory is flagged and corrected from a transaction digest. The dashboard shows the live memory, confidence changes, the activity log, Mainnet references and the Tatum usage panel.

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Stored memories expire (default epoch count is short and renewal behaviour is unclear) | Persistence promise broken; demo memories could lapse before the date they are needed | Read expiry via the read interface; alert early; write memories that must cover a chosen date close enough to it; confirm renewal with Walrus; self-hosted relayer to set epochs |
| Public relayer has no uptime guarantee and per-account limits | Writes fail or throttle | Durable queue; graceful read degradation; budgets; relayer URL in configuration; self-hosting path |
| Tatum Sui tier has no uptime guarantee; free plan limits | Verification unavailable or throttled | Cache, batch, on-demand checks, per-workspace budget, graceful degradation |
| Only one Sui transport works (gRPC; Tatum does not serve Sui JSON-RPC) | No fallback during a gRPC outage | Checks report `unknown` and degraded, never a stale pass; the gateway interface allows another provider |
| Agents do not call memory tools reliably | Briefing not seen | Generated project file, explicit check tool, tool descriptions written for proactive use, client conformance tests |
| Recall is semantic and capped | Relevant memory missed | Typed index and briefing; sort and limit controls; limit warnings |
| Memory poisoning or prompt injection through memory | Agents misled | Proposed status; provenance; untrusted-data labelling; redaction; human promotion |
| Cross-tenant leak in managed mode (shared delegate key) | Data exposure | Server-side namespace derivation; authorisation tests; owner key offline |
| Rebuild path from Walrus alone is undocumented | The "Walrus authoritative" claim weakens | Write-time capture of blob IDs; read interface for enumeration; ask Walrus; test the rebuild |
| Walrus Memory is in beta and APIs change | Breakage | Adapters; version checks against the relayer's compatibility endpoint; pinned SDK versions |
| Scope is very large | Quality suffers | Build in dependency order; core loop and demo path first |
| Third-party plugin competes for agent attention | Two memory tools in one agent | Detect and document coexistence; clear tool naming; guidance in `BUIRY.md` |
| Payment rails unavailable in the operator's country | Revenue blocked | Multiple rails; Sui-native option; confirm early |

## 16. Open questions and verification register

| ID | Question | Owner of answer | Blocks |
| --- | --- | --- | --- |
| V1 | Does the managed relayer renew Memory blobs? Who owns the blob objects? What is the real Mainnet default epoch count? | Walrus | FR-S5, FR-S6, persistence claims |
| V2 | Does the permanent-deletion API cover current memories and is it enabled on the public relayer? | Walrus | FR-S9 |
| V3 | Has key-based upsert or recall shipped (issue 247)? | Walrus | Structured state design |
| V4 | May third-party apps use the owner-scoped read interface with delegate-key authentication? | Walrus | FR-S5, FR-S8 |
| V5 | Which interface returns memory text for enumerated blob IDs, to rebuild Buiry's index? | Walrus | FR-S8 |
| V6 | Withdrawn (concerned an event criterion that no longer applies) | n/a | n/a |
| V7 | Is Sui testnet JSON-RPC retired, and is mainnet JSON-RPC guaranteed? | Tatum | FR-V2 |
| V8 | Which login methods can own a Walrus account directly (wallet, Google through zkLogin; GitHub and email unlikely)? | Walrus and Sui | FR-A2 |
| V9 | Withdrawn (concerned event rules that no longer apply) | n/a | n/a |
| V10 | Payment providers available to the operator; pricing and limits | Product | FR-Z3 |
| V11 | A mainnet JSON-RPC test call with the Tatum key still succeeds | Builder | FR-V2 |
| V12 | Does a self-hosted relayer accept the Tatum gateway for its Sui reads (header-based key)? | Walrus and Tatum | Optional infra integration |

Each item will be recorded with its answer, date and source in the decision log when resolved.

## 17. Decisions log, MCP tool catalog and glossary

### Decision log (rationale)

| ID | Decision | Rationale |
| --- | --- | --- |
| D1 | Rebuild from scratch | The previous build was studied for lessons; its audit showed unreliable foundations. |
| D3 | MCP plus check tool plus generated file for push-back | Server-initiated MCP notifications are not consistently supported across clients; the check tool and the file are dependable. |
| D5 | Walrus authoritative | Content survives the loss of any Buiry component. Buiry's index is a rebuildable cache. |
| D7 | Deterministic core, optional visible model use | Predictable, cheap, auditable; no hidden model calls. |
| D12 | Open core | Developers run client pieces next to their code. |
| D15 | Memory, not Console | Buiry needs memory semantics (namespaces, recall); Console is file storage and may serve pack exports later. |
| D16 | Operator account plus namespaces first | This is Walrus's documented multi-tenant pattern; bring-your-own and self-hosted modes follow for ownership and scale. This revises an earlier recommendation of per-workspace user-owned accounts. |
| D18 | gRPC only by default; JSON-RPC backend kept behind an explicit opt-in | Sui deprecated JSON-RPC, and Tatum's documented Sui JSON-RPC hosts returned 404 when checked live (A8). |
| D19 | Sui verification by reads, not notifications | Tatum's notification chain list does not include Sui. |
| D20 | Write memories that must cover a chosen date close enough to it, and watch expiry | Default epoch counts are short and renewal is unconfirmed. |

### MCP tool catalog

All tools are prefixed `buiry_`. Inputs are summarised; the Architecture document gives the full schemas.

| Tool | Purpose | Key inputs | Returns |
| --- | --- | --- | --- |
| `buiry_connect` | Identify project, attach the agent | project hint, branch | project metadata, counts, last activity, active branch |
| `buiry_check` | Briefing and flags | task, token budget, branch | briefing, stale, contested and expiring items, new events |
| `buiry_remember` | Write one memory | text, type, evidence, branch, supersedes | memory ID, state, redaction report |
| `buiry_remember_bulk` | Write up to 20 | items | per-item results |
| `buiry_recall` | Search | query, type, status, branch, limit | memories with confidence, status, flags (labelled as data) |
| `buiry_report` | Outcome feedback | memory ID, outcome, note | acknowledgement, new confidence |
| `buiry_resolve` | Confirm, contest, supersede or tombstone | memory ID, action, reason | new state |
| `buiry_handoff` | End-of-session summary | done, blocked, next, relied-on, notes | handoff ID |
| `buiry_verify` | Verify evidence or a memory | evidence or memory ID | verification results |
| `buiry_chain_read` | Read chain data through the gateway | kind, identifier, network | verified data, with provenance |
| `buiry_chain_simulate` | Dry-run a transaction | transaction, network | result; optional failure memory |
| `buiry_branch` | List, create, switch, propose merge | action, names | branch state |
| `buiry_status` | Health | none | write queue, relayer, gateway, expiry summary |

Resources: `buiry://project`, `buiry://briefing/{branch}`, `buiry://memory/{id}`. Prompts: onboard, handoff.

### Glossary

See the Whitepaper glossary. Additional terms: **workspace** (billing and membership boundary), **agent token** (per-agent, per-project credential), **briefing** (what an agent receives at session start), **snapshot region** (the generated part of `BUIRY.md`), **pack** (portable memory export).
