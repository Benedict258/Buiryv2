# 03. Site and messaging (sections 7 and 8)

Part of the design report (`00-index.md`). These are inputs for the copywriter and designer, not final copy. Facts point to sections 3 and 4 in `01-product-and-proof.md`.

## 7. Website map

### Rules that apply to every page

- **Tenancy shapes every call to action.** One deployment's shared managed account serves one workspace (BD41); everyone else must bring their own Walrus Memory account and delegate key (BD36). So:
  - an open "Sign up free" promise cannot be honoured for a second user without their own account;
  - calls to action must say "join the preview" or "bring your Walrus Memory account", or the owner must decide to run multi-tenant managed mode and accept A26.
- **The install command is blocked.**
  - Nothing is published (BD39), and the npm names are still the owner's call.
  - The dashboard and onboarding show `npx buiry ...`, but the release name for the CLI is `@buiry/cli` (`release.json`), not `buiry`. `npm view buiry` returned E404 on 2026-11-18, so it fetches nothing. The owner chose `npx @buiry/cli` (decision 16); it is unpublished too.
  - No page may show an install command until the packages are published under confirmed names.
- **The open-source block is blocked** until the licence notice is re-read (BD1) and the packages are published. Only `core`, `mcp` and `cli` are Apache-2.0; everything else is proprietary.
- **Name the network.** Every proof says "Sui testnet" unless it is the 2026-11-10 Mainnet check (section 4).
- **Plain-text partners.** Walrus, Sui and Tatum appear as plain text, with no logos.

### Marketing pages

| Page                                                       | Goal                                                      | Primary call to action                                                                | Key sections                                                                                     | Facts and proof usable (01, sections 3 and 4)                                                                                                          | Cannot yet be said                                                                           | Depends on owner decision                             |
| ---------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Home                                                       | Explain the problem and the promise; route to the preview | "Join the preview" (private) or "Start with your Walrus Memory account" (public, BYO) | Problem, promise, how it works in three steps, proof strip (testnet), trust summary, status line | Drift demo stages (testnet, one run); briefing first; typed memories; no self-promotion                                                                | Install command; "free"; Mainnet; behaviour rates; "audited"                                 | Positioning, visibility, testnet wording, brand       |
| How it works                                               | Show the loop: check, remember, report, hand off, verify  | "See the demo run" (the evidence report as a page)                                    | Session lifecycle; learning loop; drift; storage and verification                                | L-D1 stages; learning-loop rules (BD9, BD11); BD29 score breakdown                                                                                     | "Rebuild from Walrus"; "end-to-end encrypted"                                                | Which proof to feature                                |
| Features                                                   | Inventory for evaluators                                  | Same as home                                                                          | Grouped like section 3                                                                           | Each row's "claim it can honestly support"                                                                                                             | Bring-your-own as live-tested; Slack and Discord beyond "incoming webhook"; Cursor and Codex | none beyond home                                      |
| Pricing (placeholder)                                      | Say how pricing will work, or hide the page               | "Join the preview"                                                                    | Plan names only if shown; "prices are not set" note                                              | BD21: limits are placeholders, not prices                                                                                                              | Any price; "free forever"                                                                    | Whether pricing is shown                              |
| Security and trust                                         | Disclose the trust model honestly                         | "Read the security notes" (or contact for security reports)                           | What the relayer sees; tenant isolation; key custody; open items; how to report                  | Three isolation layers; tokens hashed; secrets sealed; internal review: 13 findings, 12 fixed with a dedicated test, M4 partial; the "still open" list | "Audited"; "zero knowledge"; "permanent"                                                     | What to show publicly about security; contact address |
| Docs hub                                                   | Get a developer connected                                 | "Connect your first agent"                                                            | Quick start, MCP tools, CLI, API, BUIRY.md, self-hosting note                                    | 13 tool names; 14 CLI commands; route list                                                                                                             | Install command until publish; self-hosted relayer (not built)                               | npm names; where docs live                            |
| Changelog                                                  | Show the product is alive                                 | none                                                                                  | Entries                                                                                          | Phase records in `docs/PROGRESS.md` (dated)                                                                                                            | Future dates (no timelines)                                                                  | Whether to publish history                            |
| Open source                                                | Explain the licence split and the open packages           | "View the source", once public                                                        | What is Apache-2.0; what is proprietary                                                          | `CLAUDE.md` rule 5; per-package `LICENSE` files                                                                                                        | Anything until BD1 re-read and publish                                                       | Licence re-read; repository visibility                |
| Showcase                                                   | Let an evaluator see a real project's confirmed memory    | none, or "Build your own"                                                             | The existing `/showcase/:pid` page, framed                                                       | BD31 rules; L-U3 (partial)                                                                                                                             | A showcase on testnet data that will lapse around 2026-11-21 without saying so               | Which project to feature                              |
| Sign in                                                    | Get existing users in                                     | "Continue with email"                                                                 | Existing `/signin`                                                                               | Email link (L-U2)                                                                                                                                      | GitHub, Google and wallet as working (L-A1 not run; no browser wallet)                       | Whether to hide unverified methods                    |
| Legal: privacy, terms, security disclosure, licence notice | Required pages                                            | none                                                                                  | Owner's or lawyer's text                                                                         | `docs/OPERATIONS.md` (what is stored), `docs/KEY_CUSTODY.md`                                                                                           | Data-deletion promises beyond tombstone and index removal (A5 partly confirmed)              | Legal entity, lawyer, contact                         |
| 404 and 500                                                | Recover                                                   | "Go home"                                                                             | Short message                                                                                    | The app's 404 ("Nothing buried here") exists                                                                                                           | n/a                                                                                          | none                                                  |

### The app (already built; see section 5)

- **Entry points from the site:** sign in, the onboarding wizard, the showcase.
- **Calls to action inside the app** that the site copy must match:
  - "Connect an agent" (Overview, Agents);
  - "Connect a storage account" (the second-user banner);
  - "Use your own account" (Storage).

### Pages that depend on owner decisions

- **Pricing:** whether pricing is shown at all.
- **Legal pages:** the legal entity, lawyer and contact address.
- **Every absolute URL:** the domain, also needed for `BUIRY_BASE_URL`.
- **Open source and docs install steps:** npm names and the licence re-read.
- **The home page call to action:** visibility (private or public).
- **Every proof point:** the testnet wording.

## 8. Messaging inputs (not final copy)

### Problem statements, with evidence

| Problem                                                      | Evidence in the repo                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Agents start each session knowing nothing about the project  | PRD section 2 (problem statement; a premise, not measured)                                                                   |
| What one tool learned is trapped in that tool                | PRD section 2; the demo hands a failure from one agent identity to another (`docs/EVIDENCE.md` stage 2, scripted)            |
| Facts go stale silently, for example after a package upgrade | Drift caught live on testnet (L-D1 stage 3); the stale deployment behaviour in L-B1 R5 (n=1)                                 |
| Nobody can audit where a remembered fact came from           | Evidence, provenance tab and activity log exist (section 3); the claim that this is a common pain is a premise, not measured |

### Candidate positioning lines

| #   | Line (candidate)                                                             | Claims it relies on                                                     | Risks                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Project memory that every coding agent shares.                               | MCP tools work across clients (L-M2 config; L-B1 Claude Code, OpenCode) | "Every" overclaims: Cursor not run, Codex no behaviour run. Say "any MCP client" only with that qualifier.                                                                                                                                                          |
| 2   | Your agents remember what failed, and notice when a fact goes stale.         | Failure-first briefing and drift (L-D1, testnet)                        | One live run; testnet only.                                                                                                                                                                                                                                         |
| 3   | Memory that belongs to the project, not the tool.                            | Memory stored per project on Walrus; export packs                       | Implies portability across deployments; re-index from Walrus is not built.                                                                                                                                                                                          |
| 4   | Every memory shows its source, and confidence is earned, never self-granted. | Evidence, BD9, BD11, the provenance tab                                 | Unit-tested on mocks; the confidence rules are not tuned on real usage. Since Phase 6.1 only a person can confirm, tested on every agent operation that writes; agent reports still raise confidence, so "never self-granted" holds for status, not for confidence. |
| 5   | Verifiable project memory, stored on Walrus and checked on Sui.              | L-W1T, L-D1, L-T4                                                       | "Verifiable" invites "verified by whom?"; only chain evidence is checked. Must name testnet.                                                                                                                                                                        |

### Proof points (all need the qualifiers in section 4)

- **Drift:** a deployment memory turned stale after a real package upgrade, and the next agent was told (testnet, one run).
- **Failure first:** a second agent identity's first briefing listed the first agent's failure first (testnet, scripted).
- **Storage report:** every stored memory has a Walrus blob id in the storage and verification report (testnet; the ids lapse around 2026-11-21).
- **Behaviour:** in our test of 10 behaviours (one run each), Claude Code called check first, ignored a planted instruction, and refused to store a secret (testnet).
- **Security:** an internal security review recorded 13 findings (3 high, 8 medium, 2 low); 12 are fixed with a dedicated regression test and M4 is fixed for new agent tokens only (by the code's author; not an audit).

### Objections, with honest answers

| Objection                                     | Honest answer                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Is this production-ready?"                   | No. It is a prototype verified on Sui testnet; there is no hosted deployment yet (L-AWS1 to L-AWS3).                                                                                      |
| "Can the storage operator read my memories?"  | In the default relayer path, yes, while processing. In managed mode one delegate reaches every namespace (A26). Bring-your-own keeps the account yours; the relayer still processes text. |
| "What if my data disappears?"                 | Walrus storage lapses; renewal is an opt-in rewrite (BD37). The database must be backed up, because re-indexing from Walrus is not built.                                                 |
| "Does it work with my agent?"                 | It speaks MCP. Claude Code and OpenCode ran on testnet; Codex configuration parsed; Cursor not tried.                                                                                     |
| "Why a blockchain?"                           | Storage is on Walrus, and chain evidence such as a deployment is checked on Sui so staleness is detected (L-D1). Whether this matters to a given user is their call.                      |
| "What does it cost?"                          | Prices are not set (BD21). Tatum credit cost is unmeasured (A9).                                                                                                                          |
| "Can agents game their own confidence?"       | Only a person can confirm a memory; an agent token cannot, on any path tested (BD44). Agents' helpful reports raise confidence only up to 0.7, below a person's confirm (0.8).            |
| "How do you compare with other memory tools?" | Not researched here. Comparisons are listed as questions for the owner (section 12).                                                                                                      |

### Glossary (product term, then the exact code name)

| Term                            | Code name                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory types                    | `decision`, `constraint`, `fact`, `failure`, `procedure`, `preference`, `task_state`, `deployment`, `handoff` (`MEMORY_TYPES`)                                                                                                        |
| Statuses                        | `proposed`, `confirmed`, `contested`, `stale`, `superseded`, `tombstoned` (`STATUSES`); storage expiry shows separately as `expired`                                                                                                  |
| MCP tools                       | `buiry_connect`, `buiry_check`, `buiry_remember`, `buiry_remember_bulk`, `buiry_recall`, `buiry_report`, `buiry_resolve`, `buiry_verify`, `buiry_handoff`, `buiry_branch`, `buiry_status`, `buiry_chain_read`, `buiry_chain_simulate` |
| Briefing                        | the result of `buiry_check`                                                                                                                                                                                                           |
| Project file                    | `BUIRY.md` (written by `buiry init`; never contains secrets)                                                                                                                                                                          |
| Namespace                       | `buiry.v1.<project_id>.<branch_slug>`                                                                                                                                                                                                 |
| Storage modes                   | `managed`, `byo` (bring your own account), `self_hosted` (refused until built)                                                                                                                                                        |
| Storage and verification report | `buiry evidence`; `GET /v1/projects/:id/evidence-report`                                                                                                                                                                              |
| Showcase                        | `/showcase/:pid`; `GET /v1/public/showcase/:id`                                                                                                                                                                                       |
| Pack                            | export and import bundle (`buiry export`, `buiry import`)                                                                                                                                                                             |
| Roles                           | `owner`, `admin`, `writer`, `reader`                                                                                                                                                                                                  |

### Tone guidance (from the docs' own voice)

- **Calm, precise, trustworthy, no hype.** State what is true, with its network or sample size.
- **Short sentences and plain words.** Name things exactly as the product does (the glossary above).
- **Say the limit next to the claim.** The docs do this throughout (for example "testnet", "one run", "estimate").
- **Treat the reader as technical.** Show the actual command, id or rule rather than adjectives.

### Words to avoid

| Avoid                                                            | Why                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| audited, certified, guaranteed, bank-grade                       | No external audit; no guarantees.                               |
| permanent, forever, immutable memory                             | Storage lapses (BD37, A1).                                      |
| end-to-end encrypted, zero-knowledge, private by design          | The relayer processes plaintext (A26).                          |
| AI that learns, self-improving, autonomous                       | The learning loop is deterministic scoring, not model training. |
| every agent, any tool, works everywhere                          | Cursor and Codex behaviour not run.                             |
| production-grade, enterprise-ready, Mainnet (as a current state) | Testnet prototype.                                              |
| revolutionary, magic, seamless, blazing fast                     | Hype, against the docs' voice.                                  |
| hackathon wording                                                | Dropped goal (`HANDOFF.md` section 1).                          |
