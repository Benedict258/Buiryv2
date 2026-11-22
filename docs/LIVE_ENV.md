# Environment for the live runs (names only)

For L-BYO1, L-BYO2 (two own accounts isolated) and L-PROOF1 (handoff proof). **Names only: no value appears in this repository, in reports or in transcripts.** Secret means it grants access and must never be pasted into chat, issues, reports or commits.

## Where each variable goes

| Where                                                  | What                                                                                                                                                | Git                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.testnet` at the repository root                  | Everything the live **scripts** read (sections 3 to 6)                                                                                              | Ignored by `.gitignore` (`.env.*`, only the two `*.example` files are tracked); never committed (no history for it). Loaded by `scripts/with-env.ts testnet -- ...`, which refuses the file if `WALRUS_NETWORK`, `TATUM_NETWORK` or `DEMO_NETWORK` names another network and prints names only |
| Render environment (dashboard or an environment group) | What the preview **server** reads (sections 1, 2 and 7)                                                                                             | Not in a file in the repository                                                                                                                                                                                                                                                                |
| `.env.render` at the repository root (optional)        | Only to run L-TOK1 from your machine against the Render database: `pnpm tsx scripts/with-env.ts render -- pnpm tsx scripts/real-pg/token-expiry.ts` | Ignored by the same `.env.*` rule                                                                                                                                                                                                                                                              |

**Guard.** Run `pnpm hooks:install` once per clone; it sets `core.hooksPath` to `.githooks`. After that:

- the `pre-commit` hook runs `scripts/secret-guard.ts --staged`;
- the `commit-msg` hook runs it on the message;
- before sharing a report or transcript, run `pnpm secret-guard`, which checks `.buiry-local/reports` and `.buiry-local/proof`, or name other paths.

The guard loads secret values from every local `.env` or `.env.<name>` file in memory, compares them with what is checked, and prints **variable names and places only**. It never prints, logs or writes a value. A hit exits 1 and blocks the commit. Tests: `scripts/secret-guard.test.ts`, on made-up values. Values shorter than 8 characters are not checked; a database URL is checked whole and for its password part.

**Limit.** A hook can be skipped (`git commit --no-verify`), so CI's gitleaks scan stays as the second line.

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

### 3. Walrus Memory account 1 (`.env.testnet`)

| Name                 | What                                                          | Secret                    |
| -------------------- | ------------------------------------------------------------- | ------------------------- |
| `PROOF_RELAYER_URL`  | Testnet relayer address for the handoff proof's `scores` step | no                        |
| `PROOF_ACCOUNT_ID`   | Account object id (`0x...`)                                   | no: an on-chain object id |
| `PROOF_DELEGATE_KEY` | Delegate private key for that account                         | **yes**                   |
| `BYO_A_RELAYER_URL`  | Tester A's relayer, for L-BYO2                                | no                        |
| `BYO_A_ACCOUNT_ID`   | Tester A's account object id                                  | no                        |
| `BYO_A_DELEGATE_KEY` | Tester A's delegate private key                               | **yes**                   |

Account 1 can be the same account for the proof and for tester A. In the handoff proof, the tester also enters this account in the dashboard (Storage page). That copy is sealed by the server and never shown again.

### 4. Walrus Memory account 2 (`.env.testnet`)

| Name                 | What                                                                                     | Secret  |
| -------------------- | ---------------------------------------------------------------------------------------- | ------- |
| `BYO_B_RELAYER_URL`  | Tester B's relayer, for L-BYO2                                                           | no      |
| `BYO_B_ACCOUNT_ID`   | Tester B's account object id; must differ from A's (the script refuses the same account) | no      |
| `BYO_B_DELEGATE_KEY` | Tester B's delegate private key                                                          | **yes** |

**L-BYO1** (`scripts/byo-live.ts`) checks the older split between a shared account and one own account, so it uses different names:

- account 1, the shared one: `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID`, `WALRUS_DELEGATE_KEY` (**secret**), and `WALRUS_NETWORK=testnet`;
- account 2: `WALRUS_BYO_TEST_RELAYER_URL`, `WALRUS_BYO_TEST_ACCOUNT_ID`, `WALRUS_BYO_TEST_DELEGATE_KEY` (**secret**).

**L-BYO1 still exits without a Tatum gateway.** Preview has no shared account, so for preview use L-BYO2, which needs no gateway.

### 5. Tatum (`.env.testnet`, optional; for the server, its Render environment)

| Name                  | What                                                                                                                                                                                                             | Secret  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `TATUM_API_KEY`       | Tatum key; without it chain checks are `unknown` and relayer recall has no Seal session (A23)                                                                                                                    | **yes** |
| `TATUM_NETWORK`       | Must be `testnet`. If unset, the gateway defaults to mainnet, and the profile loader only refuses a wrong value when one is set                                                                                  | no      |
| `TATUM_GRPC_ENDPOINT` | gRPC host:port; required when the key is set (the gateway refuses otherwise). Which testnet host to use: UNVERIFIED here, since `.env.testnet` was not read. The testnet profile ran on 2026-11-11 (ASSUMPTIONS) | no      |
| `TATUM_FREE_RPS`      | Request-rate cap                                                                                                                                                                                                 | no      |
| `TATUM_JSONRPC_URL`   | Leave unset: Tatum's Sui JSON-RPC is not served (A8)                                                                                                                                                             | no      |

### 6. Person API token (`.env.testnet`)

| Name                  | What                                                                                                                                                              | Secret  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `BUIRY_API_URL`       | The preview server's base URL (https)                                                                                                                             | no      |
| `BUIRY_PROOF_TOKEN`   | A person's API token (`bry_pat_...`), created on the API tokens page with read and write, **without** "Can confirm memories"; it expires after 90 days by default | **yes** |
| `BUIRY_PROOF_PROJECT` | The proof project's id (`prj_...`)                                                                                                                                | no      |

### 7. Preview flags (server, Render environment)

| Name                 | What                                                                                                                                                 | Secret |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `BUIRY_PREVIEW`      | `1`: preview mode                                                                                                                                    | no     |
| `BUIRY_MANAGED`      | `off`: no shared storage account                                                                                                                     | no     |
| `WALRUS_NETWORK`     | `testnet`, for the startup network check                                                                                                             | no     |
| `NODE_ENV`           | `production`                                                                                                                                         | no     |
| `VITE_BUIRY_PREVIEW` | `1`, a Docker build argument for the preview dashboard. Whether Render passes it to `docker build` is UNVERIFIED (`docs/DEPLOY_RENDER.md` section 8) | no     |
| `BUIRY_REQUEST_LOG`  | Leave unset for structured logs; `off` silences them                                                                                                 | no     |

Leave these **unset** in preview: `BUIRY_MANAGED_WORKSPACE_ID`, `BUIRY_MANAGED_MULTI_TENANT`, and the shared-account `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID` and `WALRUS_DELEGATE_KEY`. Preview refuses to start with the first two.

The server's other required names (`BUIRY_BASE_URL`, `BUIRY_ALLOWED_ORIGINS`, `BUIRY_MAILER` with `SMTP_*`, `BUIRY_ROLE`) are in `docs/DEPLOY_RENDER.md` section 3. `SMTP_PASSWORD` is **secret**.
