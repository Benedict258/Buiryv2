# Demo package (testnet)

The live demo's drift story needs a Sui package that has been upgraded: the memory cites the original package
id, and the package verifier reports "package upgraded: cited version 1, latest 2".

- `sources/demo.move` is the smallest module that can be published and upgraded. The upgrade changes the body of
  `revision()` from 1 to 2, which is an upgrade-compatible change.
- `DEMO_PACKAGE_ID` is the **original** (version 1) package id. `DEMO_TX_DIGEST` is the **upgrade** transaction
  digest. `DEMO_NETWORK` is `sui:testnet`.
- Publish from a throwaway address only, with a separate Sui CLI config under the gitignored `.buiry-local/`
  directory, never the owner's wallet. The exact commands and results are in `LOCAL_CHECKS.md` (L-D0).
