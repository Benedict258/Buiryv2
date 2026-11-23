# Live proof protocols (F1 handoff, F2 isolation)

**Status: written, not run.** Every result so far is from mocks and PGlite. Nothing in this file is a live result. Both checks need the owner's accounts, funds and setup (section 3). Neither needs a chain gateway (a Tatum key) to run: only the chain-verification step uses one, and without it that step reports `unknown`.

The pass and fail criteria below are fixed **before** any run. They are encoded in `scripts/live/proof-criteria.ts` and tested on made-up data in `proof-criteria.test.ts`. Changing a criterion after a run counts as a new protocol, and earlier runs are reported under the old one.

## 1. F1: handoff proof

**Setup:**

- The preview server (`docs/DEPLOY_RENDER.md`) on testnet, using the real testnet relayer.
- One project connected to the tester's own testnet Walrus account.
- A git repository containing `src/session.ts`.
- Claude Code and OpenCode both connected (`buiry connect claude-code`, `buiry connect opencode`).
- A person signed in to the dashboard.
- A person's API token with read and write scopes and **without** `confirm`, for the scripts.

**Steps for each run.** Driver: `scripts/live/handoff-proof.ts`. Each run is saved in `.buiry-local/proof/<run>/`.

1. `prepare <run>` creates unique tokens for the three memories, the prompts for sessions A and B, and a checklist.
2. **Session A (Claude Code)** records a decision, a constraint with file evidence on `src/session.ts`, and a failure. Each carries its run token. Save the transcript as `session-a.txt`.
3. **A person** confirms all three in the dashboard (Memory, open, Confirm).
4. **Session A** writes a handoff.
5. **Session B (OpenCode)**, a new session, calls `buiry_check` with the run's task and plans the change. Nobody tells it about session A. Save the transcript as `session-b.txt`.
6. **Conflicting change.** Commit a change to `src/session.ts` that breaks the constraint, then run `buiry verify` in the repository. Save its output as `verify-output.txt` and its exit code as `verify-exit.txt`.
7. `collect <run>` reads memories, their events, handoffs, the briefing for session B's task, open flags, and the relayer's `GET /config` network.
8. `verify-chain <run> <memoryId>` verifies one memory carrying testnet transaction evidence. Without a chain gateway on the server the result is `unknown`.
9. `scores <run>`: see A30 below.
10. `check <run>` evaluates C1 to C8 and writes `result.json`.

**Criteria.** Outcomes (`runOutcome`):

- **passed:** C1 to C7 all pass.
- **passed-chain-unknown:** C1 to C6 pass, and C7 is unknown because no chain check could run. Such a run shows nothing about the chain.
- **failed:** anything else, including a chain check that ran and did not pass.

| ID  | Passes when                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The project is on `sui:testnet` only; the relayer's `/config` says `testnet`; each of the three memories is stored with a blob id                                                  |
| C2  | A decision, a constraint and a failure, each carrying its run token, were written after the run started by a `claude-code` agent                                                   |
| C3  | All three are `confirmed`, and the confirming event's actor is a user (a person), not an agent                                                                                     |
| C4  | A `claude-code` agent wrote a handoff after the run started                                                                                                                        |
| C5  | All three are in the briefing for session B's task, **and** session B's transcript names each one (its id or its token)                                                            |
| C6  | `buiry verify` exits 1 and lists a proof memory for review, **and** a `needs_review` flag is open on that memory                                                                   |
| C7  | The chain verification of one memory returns `pass` on `sui:testnet`. Without a chain gateway it is **unknown**, shown as unknown and never as a pass; a result of `fail` fails C7 |
| C8  | A30 record: relayer recall results with a numeric distance or score were saved. C8 is recorded but does not decide the run                                                         |

C5 shows that session B used the items, not that it reasoned well with them. The reviewer adds a free-text note to each run, and that note is reported alongside the result, not counted in it.

**Repeat.** Do at least 5 runs, each with a new run id. `report` lists **every** run, including failed and incomplete ones. Never report only the best run. Each run folder keeps:

- the transcripts;
- `collected.json` (memory ids, blob ids, events);
- `chain.json`, `scores.json` and `result.json`.

### A30: real recall scores

Assumption A30 is the 0.2 relevance cutoff (Phase 9 A2). It assumes relayer scores and Buiry's relevance share a 0 to 1 scale, and that is **unverified** against the real relayer. What the code says:

- The relayer returns `distance` (cosine, lower is closer), and returns `score` only when weights are sent (`packages/storage/src/adapter.ts`).
- Buiry's recall uses `score` when present and otherwise its own lexical relevance.

`scores <run>` asks the tester's own account three fixed queries through the real relayer. For each result it saves the memory id, `distance`, `score` and Buiry's lexical relevance; no text is saved.

The step runs with or without a chain gateway, but it can only record numbers with one. Without a gateway there is no Seal session, and the relayer returns no recall results (A23, seen live on mainnet and testnet). The step then saves `sealSession: false` and the degraded flag, and C8 reads "not recordable: no chain gateway". **So A30 cannot be checked without a chain gateway.** The gateway's one Sui read builds the Seal session (`buildWalrusAdapter`), and chain reads go only through the Tatum gateway (confinement). Until these numbers have been seen and compared, **no claim is made that ranking or the cutoff behaves correctly on the live relayer**.

## Write etiquette for every live run (Phase 10)

The relayer's guidance is to keep polling a job, not to resubmit before it fails, and to retry after a few minutes. Live writes follow it (`scripts/live/etiquette.ts`, tested):

- **One account at a time.** The next account writes only after the previous write is stored, dead, or past its 65-minute deadline.
- **Health before each write.** If `/health` does not report writes `ok`, the run is **skipped**. A skipped run is recorded, but counts as neither a pass nor a fail.
- **Retries** are the drain's own: at least 10 minutes, doubling, at most 3 in any hour.
- **Records.** Every write logs its relayer job id, the UTC time, and each status with the seconds elapsed. Each run records the commit hash it used.
- **Handoff proof.** `prepare` refuses to start while writes are not `ok`; sessions write through the server, whose drain pauses while degraded.

## 2. F2: two own accounts stay isolated (L-BYO2)

**Script:** `scripts/live/byo-isolation.ts`, run as `pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/byo-isolation.ts`.

**Setup.** Preview shape, with no shared account:

- two workspaces (two testers), one project each;
- each project connected to its own testnet account;
- each agent writes one memory carrying a run marker.

No chain gateway is needed. Writes, signed listing (I4) and token checks (I2) never touch the chain. Without a gateway, I3 runs against Buiry's own recall, which is served from its index (no Seal session, A23). That still checks scoped lookups; the relayer-side recall path is not exercised. The script prints and saves which path was used (`recallPath`).

**Criteria.** Every one must pass:

| ID  | Passes when                                                                                |
| --- | ------------------------------------------------------------------------------------------ |
| I1  | Both memories are stored, each with a blob id                                              |
| I2  | Tokens: neither agent token can read the other's memory, or connect to the other's project |
| I3  | Scoped lookups: recall with one side's token never returns the other side's marker         |
| I4  | Storage: each blob is listed in its own Walrus account and not in the other                |

The script also records a control: each side finds its own memory. The control does not decide the result, but if it fails, recall itself is not working and I3 proves nothing; report it. Output is saved to `.buiry-local/proof/byo-isolation-<run>.json`. Run it at least 3 times and report each run.

## 3. What the owner must provide (F3)

1. **The Walrus Memory setup link** for creating testnet accounts, and confirmation that it is testnet. How to create, fund and add a delegate key is not recorded in this repository (`docs/TESTER_ONBOARDING.md`, step 1).
2. **Two funded testnet Walrus Memory accounts**, each with a delegate key:
   - F1 uses one of them, as the tester's own account.
   - F2 uses both: `BYO_A_*` and `BYO_B_*` (names in `scripts/live/byo-isolation.ts`).
3. **Fresh blobs.** The earlier testnet blobs lapsed around 2026-11-21; testnet storage lasts about 5 days (A28). Every live run writes new memories, so nothing older is relied on. Runs more than about 5 days apart cannot re-read earlier blobs unless `BUIRY_RENEWAL=on`.
4. **A chain gateway (a testnet Tatum key) is optional.** Without one:
   - F2 and every F1 step still run;
   - C7 is `unknown`, so runs can at best be "passed-chain-unknown", and chain verification is not shown live;
   - A30 relayer scores cannot be recorded (no Seal session, A23);
   - recall in F2 is served from Buiry's index.

   With one, all of these run on the live path. Say whether you will supply a testnet key.

5. **The preview server.** Deployed per `docs/DEPLOY_RENDER.md`, with the token migration dry run done first (L-TOK1).
6. **People and tools.** A person to confirm in the dashboard; Claude Code and OpenCode installed; a sample repository with `src/session.ts`.

## 4. `docs/TESTER_KIT.md` for Cursor and Codex testers (F4; not run)

What `buiry connect` writes, from `packages/cli/src/tools.ts`:

| Tool   | MCP config                                | Rules file                                         |
| ------ | ----------------------------------------- | -------------------------------------------------- |
| Cursor | `~/.cursor/mcp.json` (`mcpServers.buiry`) | `.cursor/rules/buiry.mdc` with `alwaysApply: true` |
| Codex  | `~/.codex/config.toml`                    | `AGENTS.md`                                        |

**Gaps found in Phase 9, and how `docs/TESTER_KIT.md` now closes them** (kit rewritten; still not run):

| #   | Gap                                  | Now in the kit                                                                                                              |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | No preview or bring-your-own storage | Section 0: connect your own testnet account first (`TESTER_ONBOARDING.md`); writes are refused until then                   |
| 2   | Cursor config location and reload    | Section 2: the files `buiry connect cursor` writes; check MCP settings; restart if not listed. Still UNVERIFIED (never run) |
| 3   | Codex rules file and behaviour       | Section 2: `~/.codex/config.toml` and `AGENTS.md`; start a new session. Behaviour still UNVERIFIED (never run)              |
| 4   | Agent versus API tokens              | Section 1: agents use the `bry_at_` token from `buiry connect`; `bry_pat_` is refused; only a person confirms               |
| 5   | Install invocation                   | Section 1: the verified `node_modules/.bin/buiry` path (L-P1 smoke); `npx` marked UNVERIFIED                                |
| 6   | R5 and R9 ids                        | Section 3: fresh testnet ids from the owner; without a chain gateway R5 is "harness", not a fail                            |
| 7   | Seeding in preview                   | Section 3: the tester seeds with `buiry remember` (exact commands)                                                          |
| 8   | Result template                      | Section 5: server, build, own account, chain gateway, seeding                                                               |
