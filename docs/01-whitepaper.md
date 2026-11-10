# Buiry Whitepaper

Oct 11, 2026 · @Benedict Isaac

## Abstract

Buiry is a project-memory layer that lets every AI coding agent on a project share one durable, verifiable memory of what was decided, what worked, what failed and what is true right now. It is not a chat history and not a vector store. It is a typed, evidence-backed record that agents write to and read from through MCP, that scores itself as it is reused or contradicted, that checks its own claims against live chain state, and that can talk back to the agent when something it remembers is no longer true.

The core idea is that agent memory should belong to the project, not to the tool. A developer who moves a repository from one agent to another, or a team whose members use different agents, should not have to re-explain the project. They install Buiry in the new tool; Buiry recognises the project, finds the existing memory, and briefs the new agent on what is trusted, what is contested, what failed before, and where the last session stopped.

Buiry stores its memory on Walrus Memory (encrypted, owner-controlled, on Mainnet) and verifies chain-dependent claims through Tatum's Sui infrastructure. Walrus holds the durable record; Buiry adds structure, scoring, verification, collaboration and a dashboard on top.

This paper describes the problem, the design, the trust model, the guarantees Buiry does and does not make, and the open questions that remain. Statements about third-party systems (Walrus Memory, Tatum) reflect their public documentation as read on 2026-10-11 and are flagged where unverified.

## 1. The problem

AI coding agents are now a normal part of building software, and most developers use more than one. Four problems follow from how that works today.

**Agents forget.** Each session starts with a context window and whatever the tool chooses to load. Decisions made last week, approaches that were tried and abandoned, and the reason a convention exists are gone unless a human restates them. Every re-explanation is a cost paid again, every session.

**Memory is trapped in the tool.** Where a tool does remember, the memory lives inside that tool, often on one machine. Walrus's own documentation describes this for Claude Code: its notes stay machine-local and per-repository, and committing them to the repo makes them visible to everyone with access and still stuck inside one tool. Switching from one agent to another, or having two teammates on two agents, resets the project's knowledge.

**Memory rots.** A remembered fact is true when it is written and may be false later: a package was upgraded, an object was replaced, a deployment moved network, a convention changed. Plain stores keep returning the old fact with the same confidence as the day it was written. An agent acting on stale memory is worse than an agent with none, because it is confidently wrong.

**Memory cannot be trusted or audited.** When an agent says "we decided X", there is rarely a record of who decided it, on what evidence, whether anyone confirmed it, or whether it has since been contradicted. A memory that cannot be traced cannot be relied on, and a poisoned or mistaken memory can steer every future session.

A fifth, quieter problem sits underneath: **persistence is not what it appears.** Decentralised storage is durable only for the period that was paid for. Any product that promises memory that lasts must treat expiry and renewal as a first-class concern rather than an implementation detail.

Existing building blocks solve parts of this. Walrus Memory provides portable, owner-controlled, verifiable memory that follows an account across Claude Code, Codex, Cursor, OpenCode and others, and Walrus documents a basic pattern for codebase memory (a namespace per repository, chunks stored and recalled by similarity). That is the storage layer Buiry builds on. What it does not provide, and what Buiry adds, is project semantics: typing, scoring, verification, collaboration, agent identity, push-back and a way to see and govern what the agents know.

## 2. Vision and principles

**Vision.** A project's memory should outlive any single agent, tool, session or machine, should say how much it can be trusted, and should be able to warn the agents that rely on it.

Buiry is designed around nine principles.

1. **The project owns the memory.** Memory is keyed to a project identity, not to a tool. Any compatible agent can attach to it.
2. **Memory is evidence, not assertion.** A memory carries who wrote it, when, on what evidence, and what has happened to it since.
3. **Trust is earned and can be lost.** Confidence rises with confirmation and successful reuse, and falls with contradiction, failure reports, drift and age.
4. **Failures are first-class.** What did not work, and why, is as valuable as what did, and is surfaced before an agent repeats it.
5. **The system can talk back.** Memory is not only queried. Buiry can tell an agent that something it relies on is stale or contested.
6. **Verify against reality where reality is checkable.** Claims that depend on chain state are checked against the chain, not trusted.
7. **Deterministic by default.** Writing, recalling, scoring and staleness checks do not depend on a language model. Where a model is used it is optional, bring-your-own-key, off by default and visible.
8. **Honest about guarantees.** Buiry states what storage, privacy and persistence it can and cannot promise, and does not overstate them.
9. **Open at the edges.** The client-side pieces (CLI, MCP server, schema, scoring) are open source so that developers can inspect what runs next to their code.

## 3. System overview

Buiry has three planes and a set of clients.

- **Data plane: Walrus Memory.** Memories are written as encrypted records to Walrus through a Walrus Memory relayer. The owner account and its delegate keys live on Sui, and the durable record is on Walrus.
- **Control plane: Buiry.** Buiry holds the project registry, agent identities, the typed memory index, the scoring engine, the push-back and alert pipeline, the activity log and the dashboard. It is a cache and a policy layer over the data plane, not a replacement for it.
- **Verification plane: Tatum.** A single gateway module routes every chain read and simulation through Tatum's Sui infrastructure to verify memories that cite chain state, and to watch the health of the storage layer itself.

| Client | Role |
| --- | --- |
| Agents (Claude Code, Codex, Cursor, OpenCode and any MCP-capable tool) | Read a briefing, write memories, report outcomes, hand off |
| Buiry CLI and local component | Install, connect, generate project files, diagnose |
| `BUIRY.md` in the repository | Identifies the project and carries rules and a briefing snapshot |
| Dashboard | See, search, confirm, contest, replay, manage projects, teams, alerts and billing |
| REST API and webhooks | Integrate with other platforms and receive alerts |

**A session in outline.** An agent connects over MCP and identifies the project from `BUIRY.md`. Buiry returns a briefing: trusted decisions and constraints, failures to avoid, flagged or contested items, and open threads. During the session the agent writes typed memories with evidence, and reports whether recalled memories helped. At the end it writes a handoff note. In the background Buiry verifies chain-dependent claims, updates confidence, and raises alerts to the dashboard, to configured webhooks, and to the agent at its next check.

## 4. The memory model

A Buiry memory is an event-sourced record. Walrus is append-only, so a memory is never edited in place: changes to its state are new events, and current state is derived from the sequence.

**Types.** Every memory has one type:

| Type | Meaning | Example |
| --- | --- | --- |
| decision | A choice and its reason | Use pnpm workspaces; npm hoisting broke the build |
| constraint | A rule that must hold | Never import from `internal/` in app code |
| fact | Something believed true about the project | The API is deployed to the staging network |
| failure | An approach that did not work, and why | Migrating in one transaction exceeded the gas limit |
| procedure | A repeatable sequence | Release steps and their order |
| preference | A human or team preference | Prefer small PRs; strict TypeScript |
| task\_state | Where work stands | Auth refactor 70% done; tests for refresh pending |
| deployment | A deployed artifact and its identifiers | Package ID and object IDs, with the transaction digest as evidence |
| handoff | A structured end-of-session summary | Done, blocked, next |

**Status.** A memory is `proposed` when an agent writes it, `confirmed` when a human or enough successful reuse promotes it, `contested` when it conflicts with another memory or a failed use, `stale` when verification finds it no longer true, `superseded` when a newer memory replaces it, and `tombstoned` when it has been withdrawn from recall. Expiry is tracked separately because it is a storage property, not a meaning property.

**Evidence.** A memory can carry evidence: a transaction digest, an object ID with a version, a file path with a commit hash, a link, or a test result. Evidence is what lets Buiry check a memory later.

**Provenance.** Each event records which agent, in which tool, on which branch and session, produced it. Walrus Memory additionally records an agent identifier on each stored memory, which Buiry uses as a second, independent source of provenance.

**Durable events and local signals.** Not every event is written to Walrus. Each write costs gas and storage and consumes relayer rate budget, so state-defining events (created, confirmed, contested, superseded, stale, tombstoned, snapshots, handoffs, merges) are durable, while high-volume signals (outcome reports, routine verification passes, recalls) are kept in Buiry's database and summarised into periodic snapshot events. This keeps the durable record sufficient to rebuild state without exhausting the storage budget.

## 5. The learning loop

The loop is what makes agent behaviour visibly change between sessions. It is deterministic by design.

**Confidence.** Each memory has a score between 0 and 1. A newly written agent memory starts low and `proposed`. Confidence rises when a human confirms it, when it is recalled and the agent reports success, and when verification re-confirms its evidence. It falls when it is contradicted, when an agent reports it as wrong or unhelpful, when verification finds drift, and gradually with age. Initial weights are tunable defaults rather than claims about optimal values, and Buiry exposes them so that teams can adjust them.

**Contradiction.** Buiry does not guess semantics. When a new memory is similar to an existing one, Buiry returns the existing memory to the writer as a conflict candidate and asks for an explicit relation: supersedes, distinct or agrees. A memory becomes `contested` only on an explicit contest, repeated wrong reports or a failed verification, so similarity alone never silently demotes a good memory. Resolution is explicit: supersede, confirm both for different branches, or tombstone. The default detector uses text similarity with no language model involved. An optional model-assisted judge can be enabled with the team's own key; every call it makes is visible in the dashboard with its inputs and outputs.

**Failure memory.** Failed approaches are stored with the error, the context and the reason. They are placed prominently in the briefing, so that an agent about to retry a known dead end sees it first.

**Proposed versus confirmed.** Agent writes do not become trusted merely by existing. This limits the damage from one bad session, a misreading agent, or a poisoned input. Humans promote memories from the dashboard, or a project can configure promotion after a number of successful reuses.

**Feedback.** Agents report outcomes through a dedicated tool. The reports feed the score and are visible in the activity log, which makes the loop observable rather than magic.

**What this does and does not claim.** Buiry's loop reorders and flags what the agent is shown. It does not guarantee that an agent will heed it. The demonstrable claim is narrower and testable: with the loop, a second session on the same task is shown the failure recorded in the first, and a stale memory is flagged before it is used.

## 6. Portability and identity

The main goal of Buiry is that a project's memory follows the project across tools, machines and people.

**Project identity.** Each project has a stable identifier recorded in `BUIRY.md`, which is committed to the repository. The file contains the project ID, human-written rules, instructions to agents on how to use Buiry, and an automatically maintained briefing snapshot. It never contains secrets. If the file is missing, Buiry can fall back to a fingerprint of the repository's remote, and asks the user to confirm.

**Attaching a new agent.** A developer who switches from one agent to another installs Buiry in the new tool with one command and one configuration entry. On first connection, Buiry identifies the project, reports what it found (for example the number of memories and which agents wrote them last), and sends an onboarding briefing. The new agent continues with the project's knowledge from that point.

**Agent identity.** Each agent connection is issued its own Buiry token, scoped to a project. Every memory records which agent produced it. In bring-your-own-account mode, agents can additionally hold their own onchain delegate keys, giving cryptographic provenance and independent revocation.

**New machine.** Because the durable record is on Walrus and the project identity is in the repository, a fresh machine needs only the repository and a login. Buiry rebuilds its working index from Walrus.

**Compatibility.** The protocol is MCP, which most coding agents support. For tools without MCP, a REST API and the generated project files provide a degraded but functional path. Buiry does not promise equal behaviour in every tool: how reliably an agent calls memory tools varies by client and model, so the briefing file and the explicit check tool are the dependable path, and push notifications are a bonus.

## 7. Verification with Tatum

Many project facts that coding agents rely on are claims about something external and checkable: that a package exists on a network, that an object has a certain version, that a transaction succeeded, that a wallet can pay for gas. Buiry treats these as verifiable.

All chain reads and simulations pass through one gateway module that talks to Tatum's Sui infrastructure. Tatum documents both a JSON-RPC gateway and a gRPC gateway for Sui mainnet, and gRPC gateways for testnet and devnet; Sui has deprecated JSON-RPC in favour of gRPC. In practice the documented Sui JSON-RPC hosts returned 404 when checked, so Buiry reads the chain over gRPC only; a JSON-RPC path stays in code behind an explicit setting. The gateway records the transport, latency and credit cost of every call, and the dashboard shows them.

| Use | What Buiry does | Tatum capability used |
| --- | --- | --- |
| Evidence-backed deployments | The agent reports a transaction digest; Buiry reads the transaction and extracts package and object identifiers as the memory's evidence | Transaction and object queries |
| Drift detection | Re-checks object versions and package upgrade history for memories that cite them, and marks them stale on mismatch | Object, batch object and package-version queries |
| Failure capture | Dry-runs a drafted transaction and stores a failed simulation as a failure memory | Transaction simulation |
| Network sanity | Flags identifiers that belong to a different network than the project's declared one | Chain and epoch queries |
| Storage health | Cross-checks the Walrus layer's own onchain state, such as account delegates and blob expiry | Owned-object and object queries |
| Readable owners | Resolves names for addresses shown in the dashboard | Name service queries |
| Pluggable verifiers | The same evidence interface for other chains through Tatum's gateway, starting with a minimal EVM verifier | JSON-RPC on other chains |

Tatum's notifications do not currently list Sui among supported chains, so Sui verification uses scheduled and on-demand reads rather than webhooks. Streaming every checkpoint would consume credits quickly under the free plan, so Buiry verifies on demand, on schedule, and when an agent calls the check tool. Tatum's Sui infrastructure is documented as a tier without an uptime guarantee, so Buiry caches results and degrades gracefully when the gateway is slow or unavailable.

Verification only helps memories that carry checkable evidence. For code-related memories, Buiry applies the same idea to the repository: file paths and commit hashes serve as evidence, and a changed file marks the memory for review. This extends the benefit to developers whose projects are not chain-dependent.

## 8. Storage, ownership and trust

**What Walrus Memory provides.** Walrus Memory stores each memory as a Seal-encrypted blob on Walrus, with a vector index in the relayer's database for semantic recall, and ownership and delegate access enforced by a Move contract on Sui. A memory space is identified by owner address, namespace and the Memory package identifier. The relayer's index is a rebuildable cache; Walrus is the durable record.

**How Buiry uses it.** Each Buiry project and branch maps to a namespace. Writes go through the relayer using a delegate key and return a blob identifier once durable. Buiry records that identifier in its own index and keeps its typed state and scores beside it. Because the content and its events are on Walrus, Buiry's index can be rebuilt; the exact rebuild path is an open item described in section 15.

**Custody modes.**

| Mode | Who owns the Walrus account | Intended for |
| --- | --- | --- |
| Managed | Buiry's operator account, with a namespace per project | Developers who do not want to manage wallets; the default |
| Bring your own account | The user or team owns the account; Buiry holds a revocable delegate key | Teams that want ownership and portability of the data |
| Self-hosted | The user also runs the relayer | Teams that need to control the trust boundary |

The managed mode follows the multi-tenant pattern in Walrus's own documentation. It carries a stated caveat that Buiry accepts: the delegate key can read every namespace under the account, so a namespace is an organisational boundary, not a security boundary between customers. In managed mode the isolation layer is Buiry's own authorisation, which derives the namespace from the authenticated project and never from client input.

**The trust boundary.** In the default relayer path, the relayer sees plaintext while it embeds and encrypts. Walrus documents three ways to reduce that trust: a client-managed flow where the client embeds and encrypts and the relayer sees only encrypted payloads and vectors; a self-hosted relayer; and a trusted-execution deployment pattern. Buiry will state the trust boundary of each mode plainly. It will not describe the managed mode as private from the relayer operator.

**Scale.** The public relayer is provided as a public good without an availability guarantee and applies per-account limits, 60 weighted requests per minute and 500 per hour by default, with a default storage quota of 1 GB per account. A self-hosted relayer can configure these limits, and can point at the same Memory package, so accounts and memories remain usable if a team moves relayers.

## 9. Branches, teams and collaboration

Several people, and several agents, often work on one project at once. Buiry models this directly.

**Branches.** A branch is a separate memory line within a project, mapped to its own Walrus namespace. A `main` branch holds the shared, trusted record. A feature branch holds working memories that may be wrong or temporary. Recall on a branch reads that branch and `main`. Merging a branch writes supersede and confirm events into the target branch rather than copying data, so lineage is preserved. Walrus namespaces match exactly and have no hierarchy, so a branch is a naming convention enforced by Buiry, and reading a branch plus `main` takes two recalls.

**Teams and roles.** A workspace contains members with roles. Proposed roles are owner, admin, writer and reader. Writers can confirm and contest memories; readers can view; admins manage agents, keys, branches and integrations; owners manage billing and the workspace.

**Concurrent agents.** Writes are append-only events with unique identifiers, so two agents never overwrite each other. Conflicts are surfaced as contested memories for resolution instead of being decided by whichever write arrived last.

**Handoffs.** At the end of a session, an agent writes a structured handoff: what was done, what is blocked, what is next, and which memories it relied on. The next agent, whichever tool it runs in, receives the handoff in its briefing.

**Replay.** Because state is derived from events, Buiry can show what the project knew at any past moment, and what each agent had been shown. This supports audit and the diagnosis of bad agent behaviour.

## 10. Security, privacy and threat model

A memory layer sits in the trust path of every agent that reads it, so its threats are direct.

| Threat | Description | Mitigation |
| --- | --- | --- |
| Memory poisoning | A bad or malicious write steers future sessions | Proposed versus confirmed status; confidence starts low; provenance and activity log; human promotion; contradiction handling |
| Prompt injection through memory | A stored memory contains instructions aimed at the agent | Memories are delivered to agents labelled as untrusted data, never as instructions; briefing templates separate them from system rules |
| Secret leakage | Credentials or keys enter a memory | Redaction before every write for credentials, tokens, private keys, seed phrases, authorisation headers and URLs with embedded credentials; storage is append-only so a stored secret cannot be reliably removed |
| Cross-tenant access in managed mode | The shared delegate key can read all namespaces | Namespace derived server-side from authenticated membership; never from client input; owner key kept offline |
| Compromised agent token | A token is stolen | Per-agent, per-project tokens; revocation; scoped permissions; rate limits; activity log |
| Compromised delegate key | A Walrus delegate key leaks | Delegate keys are revocable by the owner without touching the owner wallet; rotation procedure |
| Relayer operator sees plaintext | Default path decrypts server-side | Stated openly; client-managed and self-hosted options |
| Wrong or manipulated chain data | A verifier is fed bad data | Reads through one audited gateway; transport and node recorded; evidence stored with the result |
| Supply chain | The local component runs next to source code | Open source; reproducible builds; minimal permissions; no network access beyond Buiry and the configured relayer |

**Privacy and code.** Memories describe project knowledge and may contain proprietary context. Buiry encourages summaries over code bodies, provides redaction, and states the trust boundary of each mode. It will not make privacy claims that the underlying relayer path does not support.

**Deletion.** Walrus Memory documents owner-wallet-signed permanent deletion through a dashboard flow and a programmatic API, and a separate call that removes only the relayer's index rows. Deletion is not agent-callable. In Buiry, withdrawing a memory from recall is a tombstone event any authorised member can issue. Permanent removal of the stored blob is a separate owner-signed action and is only possible where the underlying deletion feature is available for the account; whether it covers current memories on the public relayer is an open verification item.

## 11. Persistence: expiry, renewal and deletion

A product that promises lasting memory has to be precise about what lasts.

**Storage is time-bound.** Walrus stores a blob for the number of epochs paid for. An epoch is about two weeks on Mainnet. When the epochs run out, the blob is dropped and its content cannot be recovered. Walrus Memory's own documentation states that a lapsed memory cannot be renewed. The documentation gives conflicting Mainnet defaults for the number of epochs a relayer-written memory receives (two in one place and three in another), with a configurable cap of fifteen. Buiry therefore treats the lifetime of any memory as unknown until its expiry date is read, and does not assume it is long.

**What Buiry does about it.**

1. Reads each memory's expiry from the Walrus Memory read interface, which reports an end epoch and an expiry time, and cross-checks against chain state through Tatum.
2. Shows expiry in the dashboard and alerts well before it, with a margin larger than the check interval.
3. Renews memories before they lapse, where the account's ownership model permits renewal. Who owns the blob objects of relayer-written memories, and whether the managed relayer renews them, is not clear from the documentation and is an open verification item. Until it is resolved, renewal is a design requirement and not an assumed capability.
4. In a self-hosted relayer, sets the storage epoch count for new writes.

**Deletion and forgetting.** Buiry separates three operations: tombstoning (withdrawing a memory from recall, reversible by a new event), index removal (removing the relayer's search rows for a namespace, after which the stored blobs can be re-indexed), and permanent deletion of the stored blob (owner-wallet-signed and irreversible). Users are told which one they are invoking.

**Why this matters.** Persistence is the promise. A product that stores memory for a month and presents it as permanent would fail its users silently. Making expiry visible and managed is part of the design, not a footnote.

## 12. Platform, openness and ecosystem

**Open core.** The client-side pieces are open source under a permissive licence: the command-line tool and local component, the MCP server, the memory schema and the scoring rules. The hosted platform adds the managed relayer account, the dashboard, teams and roles, alerts and integrations, replay, billing and support.

**Integrations.** Alerts and flagged items go first to the dashboard, and optionally to webhooks (Slack, Discord and generic endpoints). A REST API lets other platforms read project state, post events and receive alerts. Agents connect over MCP; tools without MCP use the API and generated files.

**Memory packs.** A project's memory can be exported as a portable pack and imported into another project or used to onboard a new teammate. Packs are also the basis for sharing curated memory, such as a template for a framework or a company's conventions.

**Public showcase.** A read-only page for a project, with links to the onchain account and live storage health, lets a team show that its memory is real. It is opt-in per project, and content visibility is controlled by the team.

**Provider neutrality.** Buiry does not depend on one agent vendor. Compatibility is a requirement of the design, and conformance is tested per client.

## 13. Economics and business model

This section records the commercial direction that has been approved in principle. Prices, limits and payment rails are open and are not stated here as decisions.

**Tiers (proposed).**

| Tier | Intended for | Characteristics |
| --- | --- | --- |
| Free | Individual developers trying Buiry | A small number of projects and memories; community support |
| Pro | Individual developers who rely on it | More projects, longer history, alerts and webhooks, replay |
| Team | Teams | Roles, shared projects, branches, audit log, per-seat pricing |
| Enterprise | Larger organisations | Single sign-on, self-hosted relayer support, data residency and support terms |

Usage add-ons may apply where cost scales with usage, such as storage and recall volume. A later marketplace for memory packs and templates is possible.

**Cost structure.** The cost drivers are the Walrus write (storage in WAL and gas in SUI), embeddings, the relayer and database, and verification credits at the gateway. Walrus documents storage pricing at a fixed fiat rate of about 0.023 USD per gigabyte per month; memories are small text records, so storage is expected to be a minor part of cost compared with gas, embeddings and operations. Unit economics have not been measured and must be worked out before prices are set.

**Payments.** Payment rails are open. Options include Sui-native payments verified through the gateway, third-party payment providers, and conventional card or bank providers. Which providers are available to a business in the operator's country is to be confirmed before billing is built.

**Open core and revenue.** Source availability of the client pieces builds trust where developers are asked to run software next to their code; revenue comes from the hosted platform, teams and enterprise features, not from the client.

## 14. Positioning and non-goals

**Relative to Walrus Memory.** Walrus Memory is the storage and portability layer, and Walrus documents a basic codebase-memory pattern. Buiry is built on it, not against it. The distinction Buiry claims is the layer above storage: typed project memory, evidence, confidence and contradiction handling, drift detection, agent identity, branches and handoffs, push-back, and a dashboard. A comparison with other agent-memory products has not yet been researched for this paper and is deliberately not made here.

**What Buiry deliberately does not do.**

- It is not a chat-history store or a general knowledge base. It records project knowledge that agents need.
- It does not run or replace coding agents.
- It does not guarantee that agents obey what they are shown, only that it shows the right things and flags the wrong ones.
- It does not claim privacy from the relayer operator in managed mode.
- It does not promise permanence beyond what storage renewal can sustain.
- It does not require a language model in the core path.

## 15. Limitations, open questions and assumptions

These are stated openly because several design choices depend on them.

| # | Open item | Why it matters | Where to resolve |
| --- | --- | --- | --- |
| 1 | Does the managed relayer renew Memory blobs, who owns the blob objects, and what is the actual default epoch count on Mainnet? | Decides whether persistence can be promised | Walrus community channel |
| 2 | Does the permanent-deletion API cover current memories and is it enabled on the public relayer? | Decides the deletion story | Walrus |
| 3 | Has key-based upsert or recall shipped, as a maintainer indicated on issue 247? | Could simplify structured state | Walrus |
| 4 | May third-party applications use the owner-scoped memory read interface with delegate-key authentication? | Enumeration and expiry monitoring | Walrus |
| 5 | Will Tatum serve Sui JSON-RPC again? Its documented hosts returned 404 when checked, so chain reads run over gRPC only | Whether a second transport exists | Tatum |
| 6 | How is Buiry's index rebuilt from Walrus alone: which interface returns memory text for a list of blob identifiers? | The claim that Buiry's state is rebuildable | Walrus |
| 7 | Pricing, limits and payment rails | Monetisation | Product decision |
| 8 | Which login methods can own a Walrus account directly (wallet and Google via zkLogin are plausible; GitHub and email probably need a Buiry-managed identity) | Onboarding design | Walrus and Sui documentation |

**Known limitations.**

- Recall is semantic and capped, so Buiry cannot guarantee that every relevant memory appears in a result. Typed state and the briefing compensate but do not eliminate this.
- Walrus namespaces have no hierarchy and no metadata fields, so structure is carried in memory text and Buiry's index.
- Recall can lag briefly behind a write.
- Public-relayer limits and the absence of an availability guarantee constrain managed mode at scale until a self-hosted relayer is used.
- Agents differ in how reliably they call memory tools.

**Assumptions.** Third-party facts in this paper come from public documentation read on 2026-10-11 and may change. Initial scoring weights are defaults to be tuned with real use.

## 16. Capability phases

Phases are ordered by dependency, not by date.

1. **Foundation.** Project identity and `BUIRY.md`; agent tokens; the MCP server with connect, check, remember, recall, report and handoff; Walrus Memory writes on Mainnet with a durable write queue; typed memory and status; redaction; the core dashboard (projects, memory explorer, activity log, agents).
2. **Intelligence.** Confidence and decay; contradiction handling; failure memory; proposed versus confirmed; the briefing generator with token budgets; the Tatum gateway with evidence-backed deployments, drift detection and simulation capture; expiry monitoring.
3. **Collaboration.** Workspaces and roles; branches and merges; replay; alerts to webhooks; the REST API; memory packs.
4. **Platform.** Billing and plans; bring-your-own-account and self-hosted relayer modes; multi-chain verifiers; public showcase; optional model-assisted judge.
5. **Ecosystem.** Template packs, a marketplace, and deeper integrations with agent vendors.

## 17. Glossary and references

**Glossary**

| Term | Meaning |
| --- | --- |
| Project | The unit that owns a memory; identified in `BUIRY.md` |
| Branch | A separate memory line within a project, mapped to a namespace |
| Memory event | An append-only record: created, confirmed, contested, superseded, validated, stale, tombstoned |
| Evidence | A checkable reference attached to a memory |
| Briefing | The set of memories and flags delivered to an agent at session start |
| Namespace | Walrus Memory's isolation label, matched exactly |
| Delegate key | A key that lets an agent or service read and write a Walrus Memory account without owning it |
| Relayer | The Walrus Memory backend that embeds, encrypts, stores and indexes |
| Epoch | A Walrus storage period, about two weeks on Mainnet |
| Tombstone | An event withdrawing a memory from recall |

**References (public documentation, read 2026-10-11)**

- [Walrus Memory overview](https://docs.wal.app/walrus-memory)
- [Memory space](https://docs.wal.app/walrus-memory/fundamentals/concepts/memory-space)
- [Ownership and delegates](https://docs.wal.app/walrus-memory/fundamentals/concepts/ownership-and-access)
- [Multi-tenant cookbook](https://docs.wal.app/walrus-memory/sdk/cookbook-multi-tenant)
- [Codebase memory](https://docs.wal.app/walrus-memory/sdk/codebase-memory)
- [Production readiness](https://docs.wal.app/walrus-memory/sdk/production-readiness)
- [Manage your memory (renewal and deletion)](https://docs.wal.app/walrus-memory/guides/manage-your-memory)
- [Relayer HTTP API](https://docs.wal.app/walrus-memory/relayer/api-reference)
- [Memory Read API](https://docs.wal.app/walrus-memory/api/memory-read-api)
- [Self-hosting](https://docs.wal.app/walrus-memory/relayer/self-hosting)
- [Tatum Sui RPC](https://docs.tatum.io/reference/rpc-sui)
- [Tatum Sui gRPC migration](https://docs.tatum.io/docs/sui-migration-guide-from-json-rpc-to-grpc)
- [Tatum notification chains](https://docs.tatum.io/reference/notifications-supported-chains)
