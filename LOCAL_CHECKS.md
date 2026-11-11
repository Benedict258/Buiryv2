# Local checks (run from a machine with network access)

Each entry: command, expected result, what to paste back.

## Live results

Run on 2026-10-28 from a Windows machine with network access. Secrets come from a gitignored `.env` and are never printed. A check is listed as verified only if it ran against the real service.

| Check                                               | Status                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-W1 (unsigned part)                                | verified                         | `curl https://relayer.memory.walrus.xyz/health`, `/version`, `/config`: HTTP 200; `writes: ok`, `write_ready: true`, `apiVersion: 1.0.0`, `relayerVersion: 0.1.0`; the contract test "reports health and a compatible version" passes against the real relayer. `/config` reports `securityDeleteEnabled: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| L-W1 (signed part: remember, recall, bulk, restore) | verified                         | Run 2026-11-10 with the delegate private key. Signed remember -> job -> `done`, bulk remember, restore (counts only) and the signed Memory Read listing pass. Recall with the Seal session (A23) returned every listed memory with text and no `degraded`: 4 of 4 in each of two namespaces (23:49:56Z, 23:50:11Z). In that run the contract test's last assertion failed because expiry was still `null` right after the write; the test now polls for it (not yet re-run live). Re-run, with the `.env` values exported (a CRLF-safe loader; `. ./.env` in bash breaks on CRLF): `BUIRY_CONTRACT_RELAYER_URL=$WALRUS_RELAYER_URL pnpm vitest run packages/storage/test/contract.test.ts --testTimeout=240000 -t REAL`. It needs `TATUM_API_KEY`, `TATUM_NETWORK=mainnet` and `TATUM_GRPC_ENDPOINT=sui-mainnet-grpc.gateway.tatum.io:443` for the session's package check. |
| L-W2                                                | verified (expiry fields)         | Signed `GET /v1/owners/{owner}/memories`: items carry `memory_id`, `namespace_id`, `blob_id`, `created_at`, `updated_at`, `size`, `agent_id`, `package_id`, `status`, `end_epoch`, `expires_at`, `importance`; the page carries `next_cursor`, `has_more`, `snapshot_version`, `deleted`, `must_resync`. `end_epoch` and `expires_at` were `null` right after the write and were filled about 4 minutes later: `end_epoch: 58`, `expires_at` 210.0 days after the read (15 epochs of 14 days). The adapter maps both. The current Walrus epoch was not read directly (Walrus epochs are not Sui epochs; "about 43" follows only from the arithmetic and is unverified).                                                                                                                                                                                                     |
| L-T0                                                | verified                         | gRPC `sui-mainnet-grpc.gateway.tatum.io:443` (TLS, `x-api-key` metadata) works. The documented JSON-RPC host `https://sui-mainnet.gateway.tatum.io` (and the testnet host) returns `404 {"statusCode":404,"message":"Not Found"}` for every path tried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L-T1                                                | contradicted                     | `curl -X POST $TATUM_JSONRPC_URL -H "x-api-key: ..." -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'` -> HTTP 404. Control: the same key on `https://ethereum-mainnet.gateway.tatum.io` returns a block number (HTTP 200), so the key and gateway work and Sui JSON-RPC is not served at the documented address. Public Sui fullnodes also reject JSON-RPC ("deprecated").                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L-T2                                                | verified (gRPC)                  | `TATUM_GRPC_ENDPOINT=sui-mainnet-grpc.gateway.tatum.io:443 TATUM_JSONRPC_URL= pnpm tsx scripts/chain-smoke.ts`: service info 1027 ms, object (Sui clock) 314 ms, package versions 170 ms, all `grpc` and `ok`; chain id `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`, epoch 1294. With `SMOKE_TX` set to a recent mainnet digest: `tx: true` (198 ms). An old digest below `lowestAvailableCheckpoint` comes back not-found. Credit figures in the output are the client's estimate; the Tatum dashboard was not read.                                                                                                                                                                                                                                                                                                                                                    |
| Custom gateway `example-gateway.gateway.tatum.io`   | not usable for Sui               | JSON-RPC: Sui methods return `-32601 Method not found`, EVM methods return upstream errors (-16500, -16429); it also answers without an API key. gRPC: "Received HTTP status code 400". Use the public `sui-mainnet-grpc` host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L-T3                                                | withdrawn                        | It concerned an event criterion that no longer applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L-A3                                                | verified                         | Real PostgreSQL (the `embedded-postgres` npm package, a throwaway server on a local port and a temp data directory): `DATABASE_URL=postgres://...@127.0.0.1:54329/buiry_smoke pnpm tsx scripts/db-smoke.ts` applied migrations 001 to 005, the tenant transaction saw only its own workspace, and the script printed `OK`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L-A4                                                | verified                         | Server on the real Postgres with Tatum gRPC configured: `GET /v1/healthz` -> `{"ok":true,"data":{"status":"ok"}}`; `POST /mcp` without a token -> 401; the built dashboard is served at `/`. The Walrus write drain was not running (no delegate private key). Doc bug found: the L-A4 command used `BUIRY_MAILER=memory`, which keeps the sign-in link inside the server process, so `buiry login --email` can never complete against it; unset it so the link is printed to the server log.                                                                                                                                                                                                                                                                                                                                                                               |
| L-M1                                                | partial                          | Claude Code 2.1.312 only, 3 runs of the same coding task that never mentions Buiry, in a scratch repo with the generated `CLAUDE.md` pointer and `BUIRY.md`: `buiry_connect` and `buiry_check` were called before any file edit in 3 of 3 runs; `buiry_handoff` at the end in 3 of 3; `buiry_connect` or `buiry_check` was called twice in each run. This measures the pointer-file path; a run without the pointer was not made. OpenCode and Codex are installed (1.19.5, 0.165.0) but need a model login, so their behaviour was not measured; Cursor is not installed.                                                                                                                                                                                                                                                                                                  |
| L-M2                                                | partial                          | `buiry login`, `init`, `connect` ran against the real server with a sandbox home directory. Claude Code 2.1.312 loaded the generated entry through `--mcp-config` and reported `buiry connected` with all 13 `buiry_*` tools (the user-level `~/.claude.json` location itself was not exercised). OpenCode 1.19.5: `opencode mcp list` -> `buiry connected`. Codex 0.165.0: `codex mcp get buiry` -> enabled, transport stdio, command and args as written. Cursor: not tested (desktop app).                                                                                                                                                                                                                                                                                                                                                                               |
| L-A1                                                | not run                          | Needs a GitHub OAuth app and a Google OAuth client registered under your accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| L-A2                                                | partial                          | Signed the live challenge with Mysten's official SDK (`@mysten/sui` 2.38.0, `Ed25519Keypair.signPersonalMessage`) from a fresh keypair: `POST /v1/auth/wallet/verify` -> 200 with a session; a signature from a different key -> 401; a replayed nonce -> 401. A fixed vector from the SDK is now a unit test. A browser wallet was not used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L-D1                                                | blocked                          | Needs the Walrus delegate private key, a Mainnet package that has since been upgraded (`DEMO_PACKAGE_ID`) and a successful publish or upgrade digest (`DEMO_TX_DIGEST`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L-U1                                                | verified (automated Chrome)      | Built dashboard and the seeded dev server (mock-backed) in Chrome 1440 px, 700 px and 390 px: 94 screenshots (dark, light, phone) with no console errors and no failed API calls; confirm-without-reload, Ctrl+K palette, theme switch, mobile tab bar and all five drawer tabs checked by script. "Gateway healthy" in this run is the mock. Not a human walk-through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L-U2                                                | partial; one bug found and fixed | Real server (real Postgres, real Tatum gRPC) in Chrome. Before the fix, the emailed link ended at `/signin?next=...` with no session. After the fix: the link signs in and lands in the workspace; cookie `buiry_session` is httpOnly and SameSite=Lax; no bearer token in localStorage; the session survives a reload; a cross-origin POST carrying the cookie -> 403; a same-origin POST -> 201. The one remaining console error is the expected 401 from the signed-out `/v1/auth/me` bootstrap probe. Wallet sign-in in the browser is not possible (connector not bundled).                                                                                                                                                                                                                                                                                            |
| L-U3                                                | partial                          | Public showcase in a fresh browser context: renders without a session, no agent names, counts and confirmed memories shown; after the owner switches it off, `GET /v1/public/showcase/:id` -> 404 and the page says "Nothing is shared here" (it also shows a raw error line and a Retry button). Invitations tab lists the pending invite with Revoke. Creating an invitation and accepting `/invite/<token>` as another account were not exercised.                                                                                                                                                                                                                                                                                                                                                                                                                       |

## L-S0. Read the live docs (Step 0; done, see `docs/ASSUMPTIONS.md`)

Open the pages listed in `docs/ASSUMPTIONS.md` and paste back, for each of A1-A6, A13-A15: the sentence(s) that answer it, with URL.
Expected: answers or "not documented". Paste back: quoted text + URLs.

## L-W1. Run the storage adapter contract against the real relayer

Needs a funded Walrus Memory account and a delegate key. Never commit these values.

```bash
export BUIRY_CONTRACT_RELAYER_URL="<relayer url>"
export WALRUS_ACCOUNT_ID="<MemWalAccount object id>"
export WALRUS_DELEGATE_KEY="<64 hex chars, ed25519 seed>"
pnpm vitest run packages/storage/test/contract.test.ts
```

Expected: a second suite named `WalrusMemoryAdapter contract: REAL relayer` runs and passes (health, version, remember -> job -> done -> recall -> list, bulk, restore).
Likely first-run failures are the assumed items A13 (signed header names/scheme), A14 (paths/JSON shapes), A15 (health shape). Paste back: the failing assertion text, the relayer's raw response for the failing call (`curl -i`, with the key removed), and the api-reference section for that endpoint.
If a shape differs, only `packages/storage/src/http-adapter.ts` (`DEFAULT_PATHS`, `DEFAULT_AUTH_HEADERS`, response mapping) and `signer.ts#canonicalRequest` change.

## L-W2. Read the real expiry of a fresh memory (resolves A2, A3)

After L-W1, call the Memory Read API listing for the contract namespace (the test prints the namespace name in its failure output; otherwise list all). Expected: `end_epoch` and `expires_at` for the new blob. Paste back: the raw JSON item, and the current epoch from the Sui system state.

## L-T0. Find the real Tatum endpoints (resolves A17)

Open https://docs.tatum.io/reference/rpc-sui and https://docs.tatum.io/docs/sui-migration-guide-from-json-rpc-to-grpc. Paste back: the mainnet gRPC host:port, the mainnet JSON-RPC URL, and the exact header name used for the API key. Then set `TATUM_GRPC_ENDPOINT` and `TATUM_JSONRPC_URL` (see `.env.example`).

## L-T1. JSON-RPC mainnet still works (resolves A8)

```bash
curl -sS -X POST "$TATUM_JSONRPC_URL" -H "x-api-key: $TATUM_API_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'
```

Expected: `{"jsonrpc":"2.0","id":1,"result":"35834a8a"}` (mainnet chain id). Paste back: the full response, or the HTTP status and body if it fails. If the header name differs, say which one worked.

## L-T2. Gateway against the real gRPC service (resolves A16, A19)

```bash
export TATUM_API_KEY=... TATUM_NETWORK=mainnet TATUM_GRPC_ENDPOINT=... TATUM_JSONRPC_URL=...
pnpm tsx scripts/chain-smoke.ts
```

The script prints, per call, the method, transport, latency, status and credit estimate for: service info, a known mainnet transaction, a known object, a package version list, and a name lookup. Paste back the whole output and the Tatum dashboard credit usage before and after. Failures with `unsupported` or field errors mean the deployed proto revision differs from the vendored one.

## L-T3. Withdrawn

This check concerned an event criterion that no longer applies (A7), so there is nothing to run.

## L-M1. Real agent clients (measure, do not assume)

For each of Claude Code, OpenCode, Cursor, Codex: run `buiry connect <tool>` in a scratch repo, start a session with a task prompt that does not mention Buiry, and note (a) whether the agent called `buiry_connect` and `buiry_check` unprompted, (b) whether it called `buiry_handoff` at the end. Paste back per tool: client version, yes/no for each, and any config issue. The generated BUIRY.md and the tool descriptions are the dependable path; this check tells us how dependable.

## L-A1. OAuth sign-in with real apps (resolves A21)

Register a GitHub OAuth app and a Google OAuth client with redirect URI `<BUIRY_BASE_URL>/v1/auth/oauth/<github|google>/callback`. Set `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `BUIRY_BASE_URL`, then start the server (L-A4) and open `<BUIRY_BASE_URL>/v1/auth/oauth/github/start` in a browser. Expected: after consent you land on the callback and receive JSON with a session token; `GET /v1/auth/me` with `Authorization: Bearer <token>` lists a workspace. Paste back: HTTP status/body of the callback (token redacted) and any provider error text.

## L-A2. Wallet sign-in with a real Sui wallet (resolves A20)

```bash
curl -sS -X POST "$BUIRY_BASE_URL/v1/auth/wallet/challenge"
```

Sign the returned `message` with a Sui wallet's "sign personal message" (Ed25519 account), then:

```bash
curl -sS -X POST "$BUIRY_BASE_URL/v1/auth/wallet/verify" -H 'content-type: application/json' \
  -d '{"nonce":"<nonce>","address":"<0x address>","signature":"<base64 signature from the wallet>"}'
```

Expected: `{"ok":true,"data":{"session":...}}`. If you get 401, paste back the wallet's signature output and the address; only `packages/api/src/auth/wallet.ts` needs to change.

## L-A3. Real Postgres (not PGlite)

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/buiry   # an empty database you can discard
pnpm tsx scripts/db-smoke.ts
```

Expected: migrations 001-005 apply, a tenant transaction under role `buiry_app` sees only its own workspace, and the script prints `OK`. Paste back the output. (Requires the role-creation privilege for `buiry_app`.)

## L-A4. Server smoke test

```bash
export BUIRY_SECRET_KEY=$(openssl rand -hex 32) BUIRY_BASE_URL=http://localhost:8787   # leave BUIRY_MAILER unset: sign-in links are then printed to the server log
pnpm tsx packages/worker/src/bin.ts
curl -sS localhost:8787/v1/healthz
```

Expected: `{"ok":true,"data":{"status":"ok"}}`; MCP is served at `/mcp`. Paste back any startup error.

## L-M2. `buiry connect` against each real tool (resolves A22)

Per tool (Claude Code, OpenCode, Cursor, Codex), in a scratch repo with the server from L-A4 running:

```bash
pnpm tsx packages/cli/src/bin.ts login --api http://localhost:8787 --email you@example.com
pnpm tsx packages/cli/src/bin.ts init --name scratch
pnpm tsx packages/cli/src/bin.ts connect <tool>
```

The generated entry launches `npx -y @buiry/mcp`, and that npm name currently resolves to the Buiry v1 package (0.1.8). Until v2 is published, set `BUIRY_MCP_COMMAND='["node","<repo>/packages/mcp/dist/bin.js"]'` (after `pnpm --filter @buiry/mcp build`) before `connect`.

Then restart the tool and ask it to list its MCP servers/tools. Expected: a `buiry` server with the 13 `buiry_*` tools. Paste back per tool: whether the config file path/shape was right (if not, the correct path and a working snippet), and the `buiry doctor` output.

## L-D1. Live two-agent demo

```bash
export WALRUS_RELAYER_URL=... WALRUS_ACCOUNT_ID=... WALRUS_DELEGATE_KEY=... TATUM_API_KEY=...
export DEMO_PACKAGE_ID=0x...   # a Mainnet package you control that has since been upgraded
export DEMO_TX_DIGEST=...      # a successful publish/upgrade transaction digest
pnpm demo --live
```

Expected: agent B is shown the failure first; the package check reports the upgrade and the memory goes stale; the corrected memory takes its evidence from the digest; the evidence section prints real blob ids and expiries. Paste back the full output. The mock run (`pnpm demo`) is not evidence of live behaviour.

## L-D2. Write the demo memories

Run it when storage leases need to cover a date you choose. Storage is leased for a limited number of epochs and lapsed memories cannot be renewed, so a memory written now may lapse before a later date; pass that date as `--valid-until` and the script warns if any memory would expire first.

```bash
export WALRUS_RELAYER_URL=... WALRUS_ACCOUNT_ID=... WALRUS_DELEGATE_KEY=...
pnpm tsx scripts/write-demo-memories.ts --valid-until <last date the memories must be readable>
```

Expected: 12 memories stored, a table of blob ids and expiry times, and exit code 0. Exit code 2 and a WARNING line mean a memory expires before the date given; run it again closer to that date. Paste back the table.

## L-U1. Dashboard in your browser against the development server

```bash
pnpm --filter @buiry/dashboard build
pnpm dev:api          # prints a workspace id, project id and a session token
```

Open `http://localhost:8787`, choose "Use a session token" and paste the token. Expected: the Northwind Labs workspace with the orbit-api project, memories with confirmed, proposed and stale statuses, a critical alert for the upgraded package, a handoff, and the sidebar live indicator green. Try: confirm a proposed memory (the row updates without a reload), open a memory (all five tabs), create a memory, open the command palette (Ctrl K), switch theme, narrow the window below 768 px. Paste back anything that looks wrong, with the browser and window size.

Optional screenshot pass (needs Chromium; `CHROMIUM_PATH` overrides the default): `pnpm dashboard:shots <token> <workspace-id> <project-id>`.

## L-U2. Dashboard against the real service

With the real service from L-A4 and a real sign-in (L-A1 or the email link), repeat L-U1 using a real project. In addition check: the cookie session works after a page reload, `Origin` checks pass when the dashboard is served by the API (`DASHBOARD_DIR`), and a wallet sign-in (L-A2) completes. The browser wallet connector is not bundled in this build, so wallet sign-in is only exercised through the API.

## L-U3. Public showcase and invitations in a browser

With `pnpm dev:api` running (it enables the showcase and creates one invitation), open `http://localhost:8787/showcase/<project-id>` in a private window with no session. Expected: counts, confirmed memories with evidence chips, storage strip, and no agent names. Then in project settings turn the showcase off and reload the public page: it should say nothing is shared. In Team, open Invitations: the pending invite shows with Revoke; creating a new one shows its link once; opening `/invite/<token>` while signed in as a different account joins the workspace.
