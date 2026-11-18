# Licence change proposal: all packages proprietary

**Status: proposal only.** Nothing here has been applied. It contains no legal text; the owner's lawyer supplies the wording of any licence or notice. The goal comes from owner decision 11 (`docs/design/05-decisions-and-gaps.md`): all packages proprietary, repository private, nothing published until the licence files match.

## 1. Where the licence is stated today (inventory, 2026-11-18)

| Place                                                                                                                             | What it says now                                                                                                                                                                                             | Apache-2.0 or proprietary |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `LICENSE` (root)                                                                                                                  | Per-package notice: core, mcp, cli are Apache-2.0; storage, chain, api, worker, dashboard, scripts, docs and everything else proprietary                                                                     | both (a notice)           |
| `NOTICE` (root)                                                                                                                   | "Open-source distribution (Apache-2.0): packages/core, packages/mcp, packages/cli." Others "proprietary placeholders"                                                                                        | both (a notice)           |
| `packages/core/LICENSE`, `packages/mcp/LICENSE`, `packages/cli/LICENSE`                                                           | Apache License 2.0 text, 55 lines each, identical. Whether this is the complete official text is unverified: the root notice says "full text"                                                                | Apache-2.0                |
| `packages/api/LICENSE`, `packages/chain/LICENSE`, `packages/storage/LICENSE`, `packages/worker/LICENSE`, `apps/dashboard/LICENSE` | "Copyright (c) 2026 Buiry. All rights reserved." (3 lines)                                                                                                                                                   | proprietary               |
| `packages/core/package.json`, `packages/mcp/package.json`, `packages/cli/package.json`                                            | `"license": "Apache-2.0"`                                                                                                                                                                                    | Apache-2.0                |
| `packages/api`, `chain`, `storage`, `worker`, `apps/dashboard` `package.json`                                                     | `"license": "UNLICENSED"`                                                                                                                                                                                    | proprietary               |
| Root `package.json`                                                                                                               | no `license` field                                                                                                                                                                                           | none                      |
| Source file headers                                                                                                               | `// SPDX-License-Identifier: Apache-2.0` in 19 files in `packages/core`, 10 in `packages/mcp` and 9 in `packages/cli`. None in api, storage, worker, dashboard or scripts                                    | Apache-2.0                |
| `packages/chain/proto/**`                                                                                                         | 30 vendored Sui protobuf files with `// Copyright (c) Mysten Labs, Inc.` and `// SPDX-License-Identifier: Apache-2.0`. **These are third-party files; their notices must stay whatever the project decides** | third party, Apache-2.0   |
| `README.md` (layout table and "Licensing" section)                                                                                | core, mcp, cli Apache-2.0; the rest proprietary                                                                                                                                                              | both                      |
| `CLAUDE.md` rule 5                                                                                                                | "`packages/core`, `packages/mcp`, `packages/cli` are Apache-2.0 (LICENSE + header). Everything else is a proprietary placeholder."                                                                           | both                      |
| `docs/DECISIONS.md` BD1                                                                                                           | Root notice replaced the MIT text; Apache-2.0 for core, mcp, cli; legal re-read pending                                                                                                                      | both                      |
| `scripts/release/pack.ts:101`                                                                                                     | Writes `license: 'Apache-2.0'` into the published package manifests; `:93` and `:107` copy `LICENSE` into the tarballs                                                                                       | Apache-2.0                |
| `release.json`                                                                                                                    | Names and version only; no licence field                                                                                                                                                                     | none                      |
| Docs that describe the split                                                                                                      | `HANDOFF.md` section 3, `docs/ARCHITECT_BRIEFING.md` section 2, `docs/design/03` (open-source block), `docs/design/05` (decisions 11 and 16)                                                                 | both                      |

## 2. History (from git, read only)

- **First commit:** `13be0e1` "Initial commit", 2026-10-22 06:47 +0100.
- **First push to the remote:** the earliest record in this clone's reflog of `origin/main` is a push on 2026-11-10 18:51 +0100 (`70cfb90`). That is only the oldest entry this clone kept. An earlier remote branch existed (`ccr-e0e1030c-5n01et`, HANDOFF history), and "Initial commit" suggests the repository was created on GitHub on 2026-10-22. **The true first push date is unverified**; GitHub's repository page or API would show it.
- **Visibility:** whether the GitHub repository is or ever was public is unverified from git; the owner should check the repository settings and history.
- **Commits that add or change Apache-2.0 text** (`git log -S "Apache-2.0"`, oldest first):
  - `519db4d` (2026-10-22, workspace setup: `CLAUDE.md`, `NOTICE`, package manifests for core, mcp, cli, PRD and architecture mentions);
  - `29b1660` (core, with SPDX headers);
  - `271cb8f` (chain, with the vendored Mysten Labs protos);
  - `45e657e`, `daf6be6` (mcp), `b3bb6fb` (cli), `3f2896a` (README);
  - `3d8b9a6`;
  - `64729f5`, `cda0cc3` (root LICENSE replaced with the per-package notice, 2026-11-10), `310976c`, `c7e0603`;
  - `e2bdac2`, `338733f`, `92f7847` (release script), `06e0acc`;
  - and the docs commits `b480535`, `c3d980e`, `ec0bc8e`, `9093ea9`.
- **What this means:** Apache-2.0 notices have been in the history since the first working commit. Whether any copy left the owner's control under those notices (a public repository, a clone, a published package) decides what a change can and cannot undo; that is a question for the lawyer. No npm package was published (`npm view` returned E404 for `buiry` and `@buiry/cli` on 2026-11-18; the other two names were not queried).

## 3. Proposed edits for "all packages proprietary" (file by file; nothing applied)

| File                                                                                   | Proposed edit                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LICENSE` (root)                                                                       | Replace the per-package notice with one proprietary notice for the whole repository, in the lawyer's wording.                                                |
| `NOTICE`                                                                               | Remove the open-source distribution line. Keep or add third-party attributions (the Mysten Labs protos, and any others the lawyer requires).                 |
| `packages/core/LICENSE`, `packages/mcp/LICENSE`, `packages/cli/LICENSE`                | Replace the Apache-2.0 text with the same proprietary notice as the other packages (lawyer's wording).                                                       |
| `packages/core/package.json`, `packages/mcp/package.json`, `packages/cli/package.json` | `"license": "UNLICENSED"`, and add `"private": true` so `npm publish` refuses them.                                                                          |
| Root `package.json`                                                                    | Add `"license": "UNLICENSED"`. It already has `"private": true` (checked), so npm refuses to publish it.                                                     |
| SPDX headers in `packages/core`, `packages/mcp`, `packages/cli` (38 files)             | Remove the `SPDX-License-Identifier: Apache-2.0` line, or replace it with the lawyer's proprietary header. A script can do it; list each file in the commit. |
| `packages/chain/proto/**`                                                              | **Do not change.** Third-party Mysten Labs files keep their own Apache-2.0 notices.                                                                          |
| `scripts/release/pack.ts`                                                              | Stop writing `license: 'Apache-2.0'` (line 101); refuse to pack while the decision is "nothing published", or remove the release scripts.                    |
| `README.md`                                                                            | Licence column and "Licensing" section say proprietary for everything.                                                                                       |
| `CLAUDE.md` rule 5                                                                     | Rewrite to "all packages are proprietary; third-party vendored files keep their own notices".                                                                |
| `docs/DECISIONS.md`                                                                    | New decision recording the change and superseding BD1 and BD39 (keep both rows as history).                                                                  |
| `HANDOFF.md`, `docs/ARCHITECT_BRIEFING.md`, `docs/design/03`, `docs/design/05`         | Update the licence facts and remove the open-source block.                                                                                                   |
| `packages/*/src` tests that check headers                                              | None found by name; check before applying that no test or lint rule requires the SPDX header (unverified).                                                   |

## 4. What the owner must provide

- The proprietary notice text, and any header text, from the lawyer.
- Confirmation of the repository's visibility history and first push date (GitHub).
- A decision on whether the release scripts stay.
