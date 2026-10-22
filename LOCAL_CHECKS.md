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
