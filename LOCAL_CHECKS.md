# Local checks (run from a machine with network access)

Each entry: command, expected result, what to paste back.

## Live results

Run on 2026-10-28 from a Windows machine with network access. Secrets come from a gitignored `.env` and are never printed. A check is listed as verified only if it ran against the real service.

| Check                                                  | Status             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L-W1 (unsigned part)                                   | verified           | `curl https://relayer.memory.walrus.xyz/health`, `/version`, `/config`: HTTP 200; `writes: ok`, `write_ready: true`, `apiVersion: 1.0.0`, `relayerVersion: 0.1.0`; the contract test "reports health and a compatible version" passes against the real relayer. `/config` reports `securityDeleteEnabled: true`.                                                                                                                                                                                                         |
| L-W1 (signed part: remember, recall, bulk, restore)    | blocked            | Every signed call returned 401. Cause found: the value supplied as the delegate key is the delegate PUBLIC key (it equals the `public_key` registered on the account object on Mainnet). The delegate private key (64 hex characters or `suiprivkey1...`) is still needed. Re-run: `set -a; . ./.env; set +a; export BUIRY_CONTRACT_RELAYER_URL="$WALRUS_RELAYER_URL"; pnpm vitest run packages/storage/test/contract.test.ts --testTimeout=240000 -t REAL`                                                              |
| L-W2                                                   | blocked            | Needs a signed call (same blocker).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L-T0                                                   | verified           | gRPC `sui-mainnet-grpc.gateway.tatum.io:443` (TLS, `x-api-key` metadata) works. The documented JSON-RPC host `https://sui-mainnet.gateway.tatum.io` (and the testnet host) returns `404 {"statusCode":404,"message":"Not Found"}` for every path tried.                                                                                                                                                                                                                                                                  |
| L-T1                                                   | contradicted       | `curl -X POST $TATUM_JSONRPC_URL -H "x-api-key: ..." -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'` -> HTTP 404. Control: the same key on `https://ethereum-mainnet.gateway.tatum.io` returns a block number (HTTP 200), so the key and gateway work and Sui JSON-RPC is not served at the documented address. Public Sui fullnodes also reject JSON-RPC ("deprecated").                                                                                                                   |
| L-T2                                                   | verified (gRPC)    | `TATUM_GRPC_ENDPOINT=sui-mainnet-grpc.gateway.tatum.io:443 TATUM_JSONRPC_URL= pnpm tsx scripts/chain-smoke.ts`: service info 1027 ms, object (Sui clock) 314 ms, package versions 170 ms, all `grpc` and `ok`; chain id `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`, epoch 1294. With `SMOKE_TX` set to a recent mainnet digest: `tx: true` (198 ms). An old digest below `lowestAvailableCheckpoint` comes back not-found. Credit figures in the output are the client's estimate; the Tatum dashboard was not read. |
| Custom gateway `example-gateway.gateway.tatum.io`      | not usable for Sui | JSON-RPC: Sui methods return `-32601 Method not found`, EVM methods return upstream errors (-16500, -16429); it also answers without an API key. gRPC: "Received HTTP status code 400". Use the public `sui-mainnet-grpc` host.                                                                                                                                                                                                                                                                                          |
| L-T3                                                   | needs you          | Question for the organisers; not answerable from here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| L-A3, L-A4, L-M1, L-M2, L-A1, L-A2, L-D1, L-U1 to L-U3 | not run yet        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## L-D1. Read the live docs (Step 0)

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

## L-T3. Hackathon criterion (resolves A7)

Ask the organisers (or the Tatum community channel) whether Sui gRPC through the Tatum gateway satisfies "Tatum Sui RPC". Paste back the answer. Buiry keeps a JSON-RPC path either way.

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
export BUIRY_SECRET_KEY=$(openssl rand -hex 32) BUIRY_BASE_URL=http://localhost:8787 BUIRY_MAILER=memory
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

Then restart the tool and ask it to list its MCP servers/tools. Expected: a `buiry` server with the 13 `buiry_*` tools. Paste back per tool: whether the config file path/shape was right (if not, the correct path and a working snippet), and the `buiry doctor` output.

## L-D1. Live two-agent demo

```bash
export WALRUS_RELAYER_URL=... WALRUS_ACCOUNT_ID=... WALRUS_DELEGATE_KEY=... TATUM_API_KEY=...
export DEMO_PACKAGE_ID=0x...   # a Mainnet package you control that has since been upgraded
export DEMO_TX_DIGEST=...      # a successful publish/upgrade transaction digest
pnpm demo --live
```

Expected: agent B is shown the failure first; the package check reports the upgrade and the memory goes stale; the corrected memory takes its evidence from the digest; the evidence section prints real blob ids and expiries. Paste back the full output. The mock run (`pnpm demo`) is not evidence of live behaviour.

## L-D2. Write the demo memories (run this close to the deadline)

Storage is leased for a limited number of epochs, so the memories must be written near the date by which they must still be readable. Do not run it early.

```bash
export WALRUS_RELAYER_URL=... WALRUS_ACCOUNT_ID=... WALRUS_DELEGATE_KEY=...
pnpm tsx scripts/write-demo-memories.ts --valid-until <last date the memories must be readable>
```

Expected: 12 memories stored, a table of blob ids and expiry times, and exit code 0. Exit code 2 and a WARNING line mean a memory expires before the date given; renew or re-run later. Paste back the table.

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
