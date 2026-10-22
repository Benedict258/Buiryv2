# Local checks (run from a machine with network access)

Each entry: command, expected result, what to paste back. Nothing here has been run by the assistant.

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
