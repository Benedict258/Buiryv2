# Tester onboarding (preview, bring your own storage)

For people testing Buiry on the owner's preview server. In preview every tester stores memories in **their own Walrus Memory account** (BD36), on the network the server runs on; the server has no shared storage account (`BUIRY_PREVIEW=1`, `BUIRY_MANAGED=off`).

**Which network.** The owner tells you whether the server runs on testnet or mainnet (`WALRUS_NETWORK`; `buiry doctor` prints it on its networks line, and the new-project form starts from it). Your account, your project and the server must all be on that one network; the server refuses anything else. A mainnet server runs only with `BUIRY_ALLOW_MAINNET=1`. Mainnet live use is UNVERIFIED beyond one partial result: one mainnet canary (2026-11-25) wrote and recalled a memory, but no canary has passed the criteria on mainnet yet.

Nothing in this guide has been run end to end by a tester yet. Steps that no record confirms are marked **UNVERIFIED**. Connecting an agent tool is in `docs/TESTER_KIT.md`; this guide covers the account, the first memory and the dashboard.

## 1. Create a Walrus Memory account on the server's network (UNVERIFIED)

What Buiry needs from it, as the Storage page asks for them:

| Field                | What it is                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Relayer URL          | Testnet: `https://relayer.dev.memwal.ai` (used in Buiry's testnet checks, and listed as "Staging (Testnet)" by Walrus). Mainnet: `https://relayer.memory.walrus.xyz` ("Production (Mainnet)"). The server refuses a hosted relayer whose network is not the one you pick |
| Network              | `testnet` or `mainnet`, the server's network                                                                                                                                                                                                                             |
| Account id           | Your account's object id (`0x...`)                                                                                                                                                                                                                                       |
| Delegate private key | A delegate key you add to the account (64 hex characters, an Ed25519 seed)                                                                                                                                                                                               |

How to create the account, fund it and add a delegate key is **not recorded in this repository**. The owner sends a Walrus Memory setup link; follow it. Walrus's docs name the mainnet dashboard `https://memory.walrus.xyz` ("Walrus Memory Playground"); the staging dashboard `https://staging.memory.walrus.xyz` is from the owner's brief, did not load for the owner, and is UNVERIFIED.

**Mainnet needs new everything.** New wallets, a new Walrus Memory account and new delegate keys: testnet accounts and keys do not carry over.

**Use a dedicated account, and throwaway data.** Create a Walrus Memory account for Buiry alone, not one that holds other memories: a delegate key reaches every namespace in its account ("Every delegate key is authorized for the whole MemWal account", https://docs.wal.app/walrus-memory/fundamentals/concepts/memory-space). Write only throwaway test text, never secrets or private project data. What is recorded: delegate keys are added in the Walrus Memory dashboard with the account owner's wallet (`docs/KEY_CUSTODY.md`).

Keep the delegate private key to yourself. Do not paste it into chat, issues or result sheets.

## 2. Sign in and create a project

1. Open the server address the owner gives you and sign in.
2. Create a project on the server's network (`sui:testnet` or `sui:mainnet`). The form starts from the server's network.
3. Until an account is connected, every project page shows: "This deployment has no shared storage account, so each project stores memories in its own Walrus Memory account." Agents can read the project, but **every write is refused** with a message that names the Storage page. Nothing is queued in the meantime (Phase 9 C1, `packages/api/test/preview-mode.test.ts`).

## 3. Connect your account

1. In the project, open **Storage**, then **Use your own account**.
2. Enter the four fields from step 1.
3. Before saving, the server checks the relayer address and the network. If a live probe is configured, it also checks that the relayer accepts the key (`validateByo`).
4. The delegate key is sealed at rest. It is never shown again and never logged (`byo-storage.test.ts`).

## 4. Connect your agent and write a first memory

1. Connect your tool with `buiry connect <tool>` (`docs/TESTER_KIT.md`, section 1).
2. Ask the agent to start with `buiry_check`. That call returns the project briefing.
3. Ask it to record a decision with `buiry_remember`, type `decision`.
4. The memory shows on the **Memory** page as `proposed`. It is stored on Walrus a little later; watch it on **Storage**.

## 5. Read the briefing

- The **Briefing** page shows what a new session receives.
- Person-confirmed memories come first among the results relevant to the task (Phase 8 B2, Phase 9 A2).
- The relevance cutoff behind that ordering is checked only against Buiry's own scoring. Whether the live relayer's scores fit it is **UNVERIFIED** (A30).

## 6. Confirm in the dashboard

1. Open the memory on the **Memory** page and press **Confirm**. This needs a project admin.
2. Only a person confirms (enforced by the server; verified on mocks and PGlite, not yet in a live or tester run). An agent's "helpful" reports raise confidence up to 0.7 at most, and mark the memory "ready for a person to confirm".
3. Agents cannot confirm, and cannot demote a memory a person confirmed: two agents reporting it wrong raise a review flag instead (Phase 6.1, 7.3, 8 B2).

## 7. Hand off

1. At the end of a session, ask the agent to call `buiry_handoff`.
2. The next session, in the same tool or another one, receives it in its briefing.
3. Handoffs are listed on the **Handoffs** page.

## 8. Limits

Each limit is stated only as far as the code and records support it.

| Limit                                                                                                                                                                                                                                                                                                                           | Source                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The relayer reads memory text in plain form while it embeds and encrypts on write, and while it decrypts on recall. Walrus's docs describe Seal encryption and this relayer processing ("the relayer performs encryption, embedding, and Walrus storage, so it sees your plaintext"); Buiry has not verified this independently | `docs/03-architecture.md`, privacy statement per mode; https://docs.wal.app/walrus-memory/ |
| Testnet storage lasts about 5 days (about one epoch a day); after that a memory's blob lapses                                                                                                                                                                                                                                   | ASSUMPTIONS A28 (confirmed on testnet)                                                     |
| Mainnet: an epoch is two weeks and storage can be bought for at most 53 epochs. How many epochs the Memory relayer buys per memory is not documented: UNVERIFIED (one mainnet write on 2026-10-28 got 15, A2)                                                                                                                   | https://docs.wal.app/docs/network-reference; ASSUMPTIONS A33                               |
| Costs, quotas and free tiers are set by Walrus and may change; Buiry has not confirmed any of them, and nothing here promises free storage                                                                                                                                                                                      | ASSUMPTIONS A33                                                                            |
| Renewal is opt-in: only with `BUIRY_RENEWAL=on` on the server does Buiry store expiring memories again. Ask the owner whether the preview server has it on                                                                                                                                                                      | `docs/OPERATIONS.md`, "Storage lifetime and renewal"                                       |
| Re-indexing from Walrus is not built: statuses, evidence, verifications and branches live only in Buiry's database. Walrus's docs describe a restore feature that rebuilds the relayer's index from stored blobs; Buiry has not built or tested a use of it                                                                     | `docs/03-architecture.md`, opening notes; https://docs.wal.app/walrus-memory/              |
| Verification returns `unknown` whenever a check cannot run (no chain gateway, rate limit, error). Without a Tatum key on the server, chain checks are always `unknown`                                                                                                                                                          | ASSUMPTIONS A8; `packages/chain/src/verifiers.ts`                                          |
| Agents raise confidence only up to the cap (0.7 for reports, 0.9 with verified evidence); only a person confirms                                                                                                                                                                                                                | `packages/core/src/learning.ts`; SECURITY_REVIEW M8                                        |
| Expiry times shown are estimates and can be off by up to an epoch (about a day on testnet)                                                                                                                                                                                                                                      | ASSUMPTIONS A29 (open)                                                                     |
| Testnet connections can time out or fail (a connect timeout and a TLS failure were seen on 2026-11-11), and from 2026-11-23 every testnet write failed with a capacity limit. Queued writes are retried; a recall or a write may still report "relayer unreachable"                                                             | ASSUMPTIONS, testnet live results; A24; `docs/LIVE_PROOF.md`                               |

## 9. What to send back

Use the result template in `docs/TESTER_KIT.md`, section 4. Add:

- whether account setup matched step 1, and where it differed;
- the memory ids you confirmed, and the blob ids from the Storage page;
- no keys, tokens or account secrets.
