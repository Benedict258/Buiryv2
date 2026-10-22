# Vendored Sui gRPC protos

Source: https://github.com/MystenLabs/sui-apis (`proto/sui/rpc/v2/*` and `proto/google/rpc/status.proto`), Apache-2.0, copyright Mysten Labs.
Fetched from the `main` branch with the transitive import closure of `ledger_service`, `state_service`, `move_package_service`, `transaction_execution_service` and `name_service`.

They are loaded at runtime with `@grpc/proto-loader` (no code generation step). To refresh:

```bash
B=https://raw.githubusercontent.com/MystenLabs/sui-apis/main/proto
curl -fsS "$B/sui/rpc/v2/ledger_service.proto" -o sui/rpc/v2/ledger_service.proto   # repeat for the five services and their imports
```

The deployed Tatum gateway may run a different `sui-apis` revision than `main` (ASSUMPTIONS A16). Only fields named in `packages/chain/src/tatum/grpc.ts` read masks are relied on.
