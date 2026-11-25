# Environment for the live runs (names only)

For L-BYO1, L-BYO2 (two own accounts isolated) and L-PROOF1 (handoff proof). **Names only: no value appears in this repository, in reports or in transcripts.** Every run names its network (below); nothing defaults to one. Secret means it grants access and must never be pasted into chat, issues, reports or commits.

## Where each variable goes

| Where                                                  | What                                                                                                                                                                                               | Git                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.testnet` at the repository root                  | Everything the live **scripts** read (sections 3 to 6)                                                                                                                                             | Ignored by `.gitignore` (`.env.*`, only the two `*.example` files are tracked); never committed (no history for it). Loaded by `scripts/with-env.ts testnet -- ...`, which refuses the file if `WALRUS_NETWORK`, `TATUM_NETWORK` or `DEMO_NETWORK` names another network and prints names only |
| Render environment (dashboard or an environment group) | What the preview **server** reads (sections 1, 2 and 7)                                                                                                                                            | Not in a file in the repository                                                                                                                                                                                                                                                                |
| `.env.mainnet` at the repository root                  | The same names for **mainnet** runs, with mainnet accounts and keys only. Loaded by `scripts/with-env.ts mainnet -- ...`, and only with `BUIRY_ALLOW_MAINNET=1` (in the file or the calling shell) | Ignored by `.gitignore` (its own `.env.mainnet` line, and `.env.*`). The `pre-commit` hook refuses any staged `.env` or `.env.<name>` file, and the secret guard compares its values like the others                                                                                           |
| `.env.render` at the repository root (optional)        | Only to run L-TOK1 from your machine against the Render database: `pnpm tsx scripts/with-env.ts render -- pnpm tsx scripts/real-pg/token-expiry.ts`                                                | Ignored by the same `.env.*` rule                                                                                                                                                                                                                                                              |

**Guard.** Run `pnpm hooks:install` once per clone; it sets `core.hooksPath` to `.githooks`. After that:

- the `pre-commit` hook runs `scripts/secret-guard.ts --staged`;
- the `commit-msg` hook runs it on the message;
- before sharing a report or transcript, run `pnpm secret-guard`, which checks `.buiry-local/reports` and `.buiry-local/proof`, or name other paths.

The guard loads secret values from every local `.env` or `.env.<name>` file in memory, compares them with what is checked, and prints **variable names and places only**. It never prints, logs or writes a value. A hit exits 1 and blocks the commit. Tests: `scripts/secret-guard.test.ts`, on made-up values. Values shorter than 8 characters are not checked; a database URL is checked whole and for its password part.

**Limit.** A hook can be skipped (`git commit --no-verify`), so CI's gitleaks scan stays as the second line.

## Networks (Phase 12)

Each procedure says which network it uses. Every live script names its network in its first output line. The canary, the isolation run (L-BYO2), the own-account check (L-BYO1), the handoff proof and the recall calibration run on testnet, or on mainnet only with `BUIRY_ALLOW_MAINNET=1`, the mainnet profile and the owner's go for each run (Phase 14).

|                                   | Testnet                                                                                                                                                                                 | Mainnet                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Profile file                      | `.env.testnet`                                                                                                                                                                          | `.env.mainnet`                                                                     |
| `WALRUS_NETWORK`, `TATUM_NETWORK` | `testnet`                                                                                                                                                                               | `mainnet`                                                                          |
| Hosted relayer                    | `https://relayer.dev.memwal.ai` ("Staging (Testnet)" in Walrus's docs); `https://relayer-staging.memory.walrus.xyz` is also accepted (owner's brief; not on Walrus's pages, UNVERIFIED) | `https://relayer.memory.walrus.xyz` ("Production (Mainnet)")                       |
| Walrus Memory dashboard           | `https://staging.memory.walrus.xyz` (owner's brief; did not load for the owner; UNVERIFIED)                                                                                             | `https://memory.walrus.xyz` (Walrus's docs call it the "Walrus Memory Playground") |
| Tatum Sui gRPC                    | `TATUM_GRPC_ENDPOINT` required. Tatum lists `https://sui-testnet-grpc.gateway.tatum.io` (port not stated)                                                                               | `https://sui-mainnet-grpc.gateway.tatum.io` when `TATUM_GRPC_ENDPOINT` is unset    |
| Opt-in                            | none; `BUIRY_ALLOW_MAINNET` is refused with this profile                                                                                                                                | `BUIRY_ALLOW_MAINNET=1` required                                                   |

Walrus sources: https://docs.wal.app/walrus-memory/relayer/public-relayer and https://docs.wal.app/walrus-memory/getting-started/quick-start (read 2026-11-24). Tatum: https://docs.tatum.io/reference/rpc-sui and https://docs.tatum.io/reference/rpc-sui-grpc.

**Rules, enforced in code** (`checkNetworkEnv` in `packages/core/src/networks.ts`; the server, `scripts/with-env.ts` for the `testnet` and `mainnet` profiles, and every script that reaches a live relayer or Tatum run it before building anything):

- The network is set explicitly. If a relayer URL or the Tatum key is set (or the server runs in production or preview) and no network is named, the run refuses. Nothing defaults to mainnet.
- The host of every `*_RELAYER_URL` (`WALRUS_`, `BYO_A_`, `BYO_B_`, `PROOF_`, ...), `WALRUS_NETWORK` and `TATUM_NETWORK` must agree. A testnet file holding a mainnet relayer URL is refused, and the reverse.
- A relayer host not in the table (self-hosted, local) is refused unless `WALRUS_RELAYER_NETWORK` names the network it serves.
- Mainnet is refused everywhere, preview mode included, without `BUIRY_ALLOW_MAINNET=1`.
- `TATUM_NETWORK` is required whenever `TATUM_API_KEY` is set.

**New accounts and keys for mainnet.** Mainnet needs new wallets, a new Walrus Memory account and new delegate keys; testnet accounts and keys do not carry over. Tatum issues separate keys per network: "Every account starts with two keys: one for **mainnet** and one for **testnet**" and "Use the key that matches the network you call" (https://docs.tatum.io/reference/authentication, read 2026-11-24). Keys live only in the git-ignored `.env.testnet` and `.env.mainnet`, never in `.env.example`, chat, issues or reports.

**Evidence.** Every live result names its network. **Mainnet:** one partial live result: the mainnet canary of 2026-11-25 (one run) completed its write in 29 seconds and a recall returned the memory, but the blob id and score were not captured, so it is not a pass of the criteria. Mainnet storage is otherwise UNVERIFIED (`LOCAL_CHECKS.md` L-CAN1). (The earlier L-W1 and L-W2 results in `LOCAL_CHECKS.md` ran against the mainnet relayer before Phase 10; they are not a canary of this code.)

## Template

### 1. Database (server; `.env.render` only for L-TOK1)

| Name                      | What                                                         | Secret                            |
| ------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `DATABASE_URL`            | Render Postgres connection string                            | **yes**: it contains the password |
| `BUIRY_SEED_ALLOW_REMOTE` | `1` lets the L-TOK1 script touch a non-local database        | no                                |
| `BUIRY_MIGRATE_ON_START`  | `1` only on a free API instance without a pre-deploy command | no                                |

### 2. Encryption key (server)

| Name                        | What                                                                                                | Secret  |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| `BUIRY_SECRET_KEY`          | HMAC for tokens, and the key that seals each project's delegate key at rest; at least 32 characters | **yes** |
| `BUIRY_SECRET_KEY_PREVIOUS` | Only during a key rotation (`docs/KEY_CUSTODY.md`)                                                  | **yes** |

The in-process L-BYO2 script does not use these: it builds its own in-memory stack, which seals delegate keys with the stack's built-in test key and discards everything on exit.

### 3. Walrus Memory account 1 (`.env.testnet`, or `.env.mainnet` for mainnet)

| Name                 | What                                                                                      | Secret  |
| -------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `BYO_A_RELAYER_URL`  | Tester A's relayer, for L-BYO2, L-BYO1, the handoff proof, the canary and the calibration | no      |
| `BYO_A_ACCOUNT_ID`   | Tester A's account object id                                                              | no      |
| `BYO_A_DELEGATE_KEY` | Tester A's delegate private key                                                           | **yes** |

Since Phase 14 the handoff proof uses tester A's account (`BYO_A_*`); the older `PROOF_*` names are no longer read (on testnet they held the same account). In the handoff proof, the tester also enters this account in the dashboard (Storage page). That copy is sealed by the server and never shown again.

### 4. Walrus Memory account 2 (`.env.testnet`, or `.env.mainnet` for mainnet)

| Name                 | What                                                                                                                      | Secret  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `BYO_B_RELAYER_URL`  | Tester B's relayer, for L-BYO2                                                                                            | no      |
| `BYO_B_ACCOUNT_ID`   | Tester B's account object id; must differ from A's (the scripts refuse the same account id, delegate key or owner wallet) | no      |
| `BYO_B_DELEGATE_KEY` | Tester B's delegate private key                                                                                           | **yes** |

**L-BYO1** (`scripts/byo-live.ts`) checks the split between a managed account and one own account. Since Phase 14 it uses the same two accounts: `BYO_A_*` is the project's own account and `BYO_B_*` plays the managed account. The older `WALRUS_BYO_TEST_*` names are no longer read.

**L-BYO1 still exits without a Tatum gateway.** Preview has no shared account, so for preview use L-BYO2, which needs no gateway.

### 5. Tatum (`.env.testnet` or `.env.mainnet`, optional; for the server, its Render environment)

| Name                  | What                                                                                                                                                                                                                          | Secret  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `TATUM_API_KEY`       | Tatum key; without it chain checks are `unknown` and relayer recall has no Seal session (A23)                                                                                                                                 | **yes** |
| `TATUM_NETWORK`       | The profile's network (`testnet` or `mainnet`). Required whenever `TATUM_API_KEY` is set: the gateway refuses to build without it and never defaults it (Phase 12)                                                            | no      |
| `TATUM_GRPC_ENDPOINT` | gRPC host:port or URL. Testnet: required (Tatum lists `https://sui-testnet-grpc.gateway.tatum.io`; which value `.env.testnet` holds was not read). Mainnet: optional; unset means `https://sui-mainnet-grpc.gateway.tatum.io` | no      |
| `TATUM_FREE_RPS`      | Request-rate cap (default 3). Tatum's pages give different free-plan figures (A32); check the owner's Tatum dashboard                                                                                                         | no      |
| `TATUM_JSONRPC_URL`   | Leave unset: Tatum's Sui JSON-RPC is not served (A8)                                                                                                                                                                          | no      |

### 6. Person API token (`.env.testnet`)

| Name                  | What                                                                                                                                                              | Secret  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `BUIRY_API_URL`       | The preview server's base URL (https)                                                                                                                             | no      |
| `BUIRY_PROOF_TOKEN`   | A person's API token (`bry_pat_...`), created on the API tokens page with read and write, **without** "Can confirm memories"; it expires after 90 days by default | **yes** |
| `BUIRY_PROOF_PROJECT` | The proof project's id (`prj_...`)                                                                                                                                | no      |

### 7. Preview flags (server, Render environment)

| Name                     | What                                                                                                                                                 | Secret |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `BUIRY_PREVIEW`          | `1`: preview mode                                                                                                                                    | no     |
| `BUIRY_MANAGED`          | `off`: no shared storage account                                                                                                                     | no     |
| `WALRUS_NETWORK`         | `testnet` or `mainnet`: required in preview; the startup check refuses a mismatch with any relayer host or `TATUM_NETWORK`                           | no     |
| `BUIRY_ALLOW_MAINNET`    | `1` only for a mainnet preview; without it a mainnet server refuses to start, and testers' mainnet accounts are refused                              | no     |
| `WALRUS_RELAYER_NETWORK` | Only for a relayer host Buiry does not recognise: the network it serves                                                                              | no     |
| `NODE_ENV`               | `production`                                                                                                                                         | no     |
| `VITE_BUIRY_PREVIEW`     | `1`, a Docker build argument for the preview dashboard. Whether Render passes it to `docker build` is UNVERIFIED (`docs/DEPLOY_RENDER.md` section 8) | no     |
| `BUIRY_REQUEST_LOG`      | Leave unset for structured logs; `off` silences them                                                                                                 | no     |

Leave these **unset** in preview: `BUIRY_MANAGED_WORKSPACE_ID`, `BUIRY_MANAGED_MULTI_TENANT`, and the shared-account `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID` and `WALRUS_DELEGATE_KEY`. Preview refuses to start with the first two.

The server's other required names (`BUIRY_BASE_URL`, `BUIRY_ALLOWED_ORIGINS`, `BUIRY_MAILER` with `SMTP_*`, `BUIRY_ROLE`) are in `docs/DEPLOY_RENDER.md` section 3. Of those, `SMTP_PASSWORD` is **secret**, and so are the optional `GITHUB_CLIENT_SECRET` and `GOOGLE_CLIENT_SECRET`.
