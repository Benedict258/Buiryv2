# Live proof protocols (F1 handoff, F2 isolation)

**Status: testnet runs failed with nothing stored; one partial mainnet canary.** F2 isolation runs 1 to 3 (2026-11-23) and write canaries 1 to 3 (2026-11-23 and 2026-11-24) ran on testnet and failed on the relayer's capacity limit (run 1's error text was not captured; runs 2 and 3 and all three canaries recorded the capacity limit). Nothing was stored on testnet, so there is no testnet recall or isolation result. F1 (handoff proof) has not run; it needs stored writes. On mainnet there is one partial live result: the mainnet canary of 2026-11-25 (one run) completed its write in 29 seconds and a recall returned the memory, but the blob id and score were not captured, so it is not a pass of the criteria. Mainnet storage is otherwise UNVERIFIED. No isolation run or handoff proof has run on mainnet. Every passing result so far is from mocks and PGlite. Both checks need the owner's accounts, funds and setup (section 3). Neither needs a chain gateway (a Tatum key) to run: only the chain-verification step uses one, and without it that step reports `unknown`.

The pass and fail criteria below are fixed **before** any run. They are encoded in `scripts/live/proof-criteria.ts` and tested on made-up data in `proof-criteria.test.ts`. Changing a criterion after a run counts as a new protocol, and earlier runs are reported under the old one.

## 1. F1: handoff proof

**Setup:**

- The preview server (`docs/DEPLOY_RENDER.md`) on the run's network, using that network's relayer.
- One project connected to the tester's own Walrus account on that network (tester A, `BYO_A_*`).
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

**On mainnet (Phase 14).** Not run on mainnet. The driver runs on testnet, or on mainnet as `BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/handoff-proof.ts <step> <run>`, with `.env.mainnet` with tester A's mainnet account `BYO_A_*` ( `RELAYER_URL` = `https://relayer.memory.walrus.xyz`, `ACCOUNT_ID`, `DELEGATE_KEY`), `WALRUS_NETWORK=mainnet`, `TATUM_NETWORK=mainnet` and the mainnet Tatum key, and a preview server on mainnet. Every step that reaches a server, relayer or chain prints the network first; `prepare` saves the network with the run, and `collect`, `verify-chain` and `scores` refuse settings that name another network. C1 and C7 judge the network the run was prepared on (BD50); runs saved before Phase 14 are judged on testnet. Each live run needs its own go from the owner.

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
- **Errors (Phase 14b).** Every live script prints an error as its class (timeout, network, http, parse, invalid-response or local), its kind, the HTTP status if any and the network cause code if any, for example `RelayerError class=network kind=unavailable cause=ECONNRESET`. It never prints the response text, a URL, a header, a key or any value. The scripts' own refusals print as written.
- **Handoff proof.** `prepare` refuses to start while writes are not `ok`; sessions write through the server, whose drain pauses while degraded.

**Relayer health is not a reliable signal.** On 2026-11-23 the testnet relayer's `/health` reported `writes: ok` from 01:07 to 05:03 UTC, while every one of 13 writes failed with a capacity limit. "Writes ok" is therefore necessary before a live run, never sufficient. Readiness is shown by a canary, not by `/health`.

**Isolation runs (F6).** Each account gets exactly one attempt per run: the drain is set to `maxAttempts: 1`, so a failed attempt is final and nothing retries in the background into the next account's phase. The run waits for that attempt's terminal state (up to 20 minutes). I1 is still scored at the fixed 4 minutes (`storedWithin`).

## Canary: is the relayer storing and returning writes?

`scripts/live/canary.ts`, run as `pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/canary.ts`, or on mainnet, only on the owner's go, as `BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/canary.ts`.

- **Network first (Phase 12).** It refuses unless the network is named and the relayer host, `WALRUS_NETWORK` and `TATUM_NETWORK` agree; on mainnet it also needs `BUIRY_ALLOW_MAINNET=1`. It refuses without a chain gateway, since a recall then cannot return real results. Its first output line names the network and relayer host, and the saved result is labelled with it.
- **Evidence.** Every live result is labelled with its network. Mainnet: one partial live result: the mainnet canary of 2026-11-25 (one run) completed its write in 29 seconds and a recall returned the memory, but the blob id and score were not captured, so it is not a pass of the criteria. Mainnet storage is otherwise UNVERIFIED. The three testnet canaries of 2026-11-23 and 2026-11-24 all failed with a capacity limit.

- **One write, one attempt.** It writes one memory on account A, straight to the relayer, with no retry.
- **Followed to the end.** It follows the job to `done` or `failed`, logging the job id, UTC times and each status with elapsed seconds.
- **Recall check.** If the write is stored, it recalls the memory through the relayer, using a Seal session when a chain gateway is configured. It records whether the canary came back, its raw distance, each result's field names (names only) and raw distance, and a score only if the relayer sent one. Buiry does not send `scoring_weights`, so the relayer sends no score (A30).
- **Pacing.** At most one per hour: it refuses if the last canary started less than an hour ago. The start is recorded before the write, so an interrupted canary still uses the hour. It also refuses while `/health` does not report writes `ok`; that refusal does not use the hour.
- **Results.** Saved to `.buiry-local/proof/canary-<run>.json`, including the blob id from the finished job. No key, token or memory text is saved.
- **Pass criteria (Phase 13, BD49).** PASS = the write job completes and returns a blob id; a recall returns that memory; its raw distance is recorded. A relayer score is not required: the relayer returns one only when `scoring_weights` is sent, and Buiry does not send it (A30). The 2026-11-25 mainnet run failed the earlier criteria only because the canary did not save the blob id (the adapter already returned it) and because the score criterion was wrong; it ran before these criteria and is recorded as a partial live result, not a pass.
- **Gate for everything else.** No isolation run, handoff setup or handoff proof starts until a canary **passes** the criteria above.

## 2. F2: two own accounts stay isolated (L-BYO2)

**Script:** `scripts/live/byo-isolation.ts`, run as `pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/byo-isolation.ts`, or on mainnet as `BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/byo-isolation.ts`.

**Setup.** Preview shape, with no shared account:

- two workspaces (two testers), one project each;
- each project connected to its own account on the run's network;
- each agent writes one memory carrying a run marker.

No chain gateway is needed. Writes, signed listing (I4) and token checks (I2) never touch the chain. Without a gateway, I3 runs against Buiry's own recall, which is served from its index (no Seal session, A23). That still checks scoped lookups; the relayer-side recall path is not exercised. The script prints and saves which path was used (`recallPath`).

**Criteria.** Every one must pass:

| ID  | Passes when                                                                                |
| --- | ------------------------------------------------------------------------------------------ |
| I1  | Both memories are stored, each with a blob id                                              |
| I2  | Tokens: neither agent token can read the other's memory, or connect to the other's project |
| I3  | Scoped lookups: recall with one side's token never returns the other side's marker         |
| I4  | Storage: each blob is listed in its own Walrus account and not in the other                |

The script also records a control: each side finds its own memory. The control does not decide the result, but if it fails, recall itself is not working and I3 proves nothing; report it. Output is saved to `.buiry-local/proof/byo-isolation-<run>.json`, labelled with its network. Run it at least 3 times and report each run.

**Mainnet isolation procedure (Phase 14).** Not run on mainnet; no isolation run has passed on any network.

1. **Accounts.** `.env.mainnet` with two mainnet accounts: `BYO_A_*` and `BYO_B_*` (each `RELAYER_URL` = `https://relayer.memory.walrus.xyz`, `ACCOUNT_ID`, `DELEGATE_KEY`), `WALRUS_NETWORK=mainnet`, `TATUM_NETWORK=mainnet` and the mainnet Tatum key. The two accounts must be different accounts with different owners.
2. **Guards before anything connects.** The script refuses:
   - a missing `BYO_A_*` or `BYO_B_*` name, the same account id twice, or the same delegate key twice (names only in every message);
   - settings whose network is unnamed or inconsistent, mainnet without `BUIRY_ALLOW_MAINNET=1`, or any network other than testnet or mainnet.

   Its first output line names the network and relayer host.

3. **Guards before the first write.** For each account it reads the relayer's `/config` and refuses a network other than the one checked. It reads both owner wallets (read-only `POST /api/stats`) and refuses if they are the same.
4. **Unchanged.** The write etiquette, pacing, one attempt per account, the I1 to I4 criteria and the control.
5. **A go per run.** Each live run needs its own go from the owner, after a mainnet canary has passed (BD49).

**Own-account check (L-BYO1, `scripts/byo-live.ts`).** It uses the same two accounts and guards: `BYO_A_*` is the project's own account, and `BYO_B_*` plays the managed account. On mainnet: `BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/byo-live.ts`. It needs the chain gateway and writes two memories. Not run on mainnet. Each live run needs its own go from the owner.

## Recall calibration (read-only, Phase 14)

**Script:** `scripts/live/recall-calibrate.ts <canaryRun>`, run as `pnpm tsx scripts/with-env.ts testnet -- pnpm tsx scripts/live/recall-calibrate.ts <canaryRun>`, or on mainnet as `BUIRY_ALLOW_MAINNET=1 pnpm tsx scripts/with-env.ts mainnet -- pnpm tsx scripts/live/recall-calibrate.ts <canaryRun>`. `<canaryRun>` is a stored canary (`.buiry-local/proof/canary-<run>.json`, final `done`) on the same network.

- **Recalls only, never writes.** It reads account A's canary namespace (`buiry.canary.<run>`).
- **Guards.** The canary's preflight runs first: `BYO_A_*`, a named and consistent network, mainnet only with the opt-in, and the chain gateway for the Seal session. Then the network line, and the relayer's `/config` compared with it.
- **Queries.** 10 fixed queries, at most 12, in five labelled categories:
  - exact: the canary text, at the submit second and the second before, since the canary saves only its submit time;
  - a close paraphrase;
  - the same topic in different words;
  - a related but different topic;
  - an unrelated topic.
- **Pacing.** One recall per query, no retry (the adapter's read retry is off), at least 2 seconds apart. It stops on the first error.
- **Saved.** `.buiry-local/proof/calibrate-<canaryRun>-<id>.json`: the network, commit and canary run, then per query only the category label, query id, number of results and raw distances. Never query text or memory text.
- **Status.** Not run. Each live run needs its own go from the owner. Its distances are the input A30 needs before the 0.2 relevance cutoff can be judged.

## 3. What the owner must provide (F3)

1. **The Walrus Memory setup link** for creating testnet accounts, and confirmation that it is testnet. How to create, fund and add a delegate key is not recorded in this repository (`docs/TESTER_ONBOARDING.md`, step 1).
2. **Two funded testnet Walrus Memory accounts**, each with a delegate key:
   - F1 uses tester A's, `BYO_A_*`, as the tester's own account.
   - F2 and L-BYO1 use both: `BYO_A_*` and `BYO_B_*`.
   - For mainnet the same names go in `.env.mainnet`, with mainnet accounts (two different owners).
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
