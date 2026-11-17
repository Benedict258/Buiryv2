# Key custody

Every secret Buiry uses: what it unlocks, where it lives, who can read it, and how to rotate it. Values never appear in the repository, in logs, in error messages or in API responses. The tests check this for sign-in links, SMTP passwords and delegate keys.

| Secret                                            | What it unlocks                                                                                                                                           | Where it lives                                                                                                          | Rotation                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUIRY_SECRET_KEY`                                | HMAC for agent and API tokens; the key that seals each project's Walrus delegate key and webhook secrets (AES-256-GCM, separate derived keys per purpose) | Secrets Manager; a second copy offline (sealed envelope or a separate password manager), never next to database backups | Runbook below: deploy with the new key plus `BUIRY_SECRET_KEY_PREVIOUS`, re-seal stored secrets with `dist-server/rotate-key.js`, remove the previous key after the overlap. Tokens keep working and are re-hashed on first use.            |
| `DATABASE_URL` (RDS master or app user)           | The whole database                                                                                                                                        | RDS-managed master secret in Secrets Manager; the app should use a separate least-privilege user (follow-up)            | RDS rotation for the master secret; restart services after rotation                                                                                                                                                                         |
| `WALRUS_DELEGATE_KEY` (managed account)           | Writing to and reading from the managed Walrus Memory account, and building Seal sessions for it                                                          | Secrets Manager                                                                                                         | Add a new delegate in the Walrus Memory dashboard (owner wallet), update the secret, redeploy, verify (L-W1), then remove the old delegate. Keys a removed delegate already fetched still decrypt the memories they were fetched for (A26). |
| Per-project delegate keys (bring your own)        | That project's own Walrus account                                                                                                                         | Database, sealed with `BUIRY_SECRET_KEY`; never returned, only the public key is shown                                  | The project admin rotates the key in the Storage page (same account); the old adapter is dropped from the cache at once                                                                                                                     |
| Walrus owner wallet                               | Adding and removing delegates; permanent deletion                                                                                                         | With the owner only; never on a server                                                                                  | Not stored by Buiry                                                                                                                                                                                                                         |
| `TATUM_API_KEY`                                   | Sui reads through the Tatum gateway (credits)                                                                                                             | Secrets Manager                                                                                                         | New key in the Tatum dashboard, update the secret, redeploy, revoke the old key                                                                                                                                                             |
| `SMTP_PASSWORD`                                   | Sending email as the sign-in sender                                                                                                                       | Secrets Manager                                                                                                         | Rotate at the provider, update the secret, redeploy                                                                                                                                                                                         |
| OAuth client secrets                              | GitHub / Google sign-in                                                                                                                                   | Secrets Manager                                                                                                         | Rotate at the provider                                                                                                                                                                                                                      |
| Agent tokens (`bry_at_…`)                         | One agent on one project                                                                                                                                  | Hashed (HMAC) in the database; plaintext only in the tool's local config                                                | Expire after `BUIRY_AGENT_TOKEN_MAX_DAYS` (default 90); the Agents page reminds 14 days ahead. Rotate in the dashboard (the old token stops at once, BD40), then update the tool (`buiry connect`).                                         |
| API tokens (`bry_pat_…`)                          | Scoped workspace access                                                                                                                                   | Hashed in the database                                                                                                  | Optional expiry; revoke in the dashboard                                                                                                                                                                                                    |
| Session cookies, sign-in links, invitation tokens | A signed-in session; one sign-in; one invitation                                                                                                          | Hashed in the database; links are single use and short-lived                                                            | Sign out or revoke a session                                                                                                                                                                                                                |
| Sui testnet throwaway key (demo)                  | The demo package on testnet only                                                                                                                          | `.buiry-local/sui-testnet/` on the developer machine (gitignored)                                                       | Discard; never reused on Mainnet                                                                                                                                                                                                            |

## Runbook: rotating BUIRY_SECRET_KEY

What depends on the key:

| Data                                                                                                                  | Kind                                             | What rotation does                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook signing secrets (`webhooks.secret`), per-project Walrus delegate keys (`project_storage.delegate_key_sealed`) | Encrypted (AES-256-GCM, key derived per purpose) | Re-sealed under the new key by `rotate-key` in one verified transaction                                                                                                |
| Session, agent token and API token hashes                                                                             | HMAC, one-way                                    | Cannot be re-encrypted. While `BUIRY_SECRET_KEY_PREVIOUS` is set, a token hashed with the old key is accepted and its hash is rewritten under the new key on first use |
| Sign-in links, invitations                                                                                            | HMAC, single use                                 | Accepted under the old key while it is set; they expire on their own (15 minutes, invitation lifetime)                                                                 |

Order of operations (each step reversible until step 7):

1. **Generate the new key**: 48 random bytes, for example `openssl rand -base64 48`. Store it as a new Secrets Manager secret (for example `buiry-prod/BUIRY_SECRET_KEY_NEXT`). Never paste it into chat, tickets or logs.
2. **Back up**: take an RDS snapshot. Keep a copy of the old key in the offline backup until step 8.
3. **Deploy with both keys**: `BUIRY_SECRET_KEY` = new, `BUIRY_SECRET_KEY_PREVIOUS` = old. The startup check refuses a previous key that is short or equal to the current one. From here:
   - stored secrets still open (decryption falls back to the old key);
   - sessions and tokens keep working and move to the new key as they are used.
4. **Dry run**: run the `rotate-key` task with `DATABASE_URL`, `BUIRY_SECRET_KEY_OLD` = old and `BUIRY_SECRET_KEY_NEW` = new, without `--apply`. On AWS, run the image's `node dist-server/rotate-key.js` as a one-off task with those variables from Secrets Manager. It prints:
   - counts of rows to re-seal, already re-sealed and verified;
   - if any row opens with neither key, the table and id of each such row, with nothing changed. Fix or delete those rows, for example a webhook whose secret was corrupted (recreate it).
5. **Apply**: the same command with `--apply`. Either every secret is re-sealed and verified, or nothing is written. A re-run is safe: rows already under the new key are skipped.
6. **Verify**:
   - send a test webhook delivery;
   - open the Storage page of a project with its own Walrus account;
   - run `scripts/smoke-deploy.ts`.
7. **Overlap**: keep `BUIRY_SECRET_KEY_PREVIOUS` until every active agent has used its token since step 3. The Agents page "Token used" column shows this. Sessions re-hash on their next request. Tokens not used during the overlap stop working when the previous key is removed; rotate them from the Agents page.
8. **Finish**:
   - remove `BUIRY_SECRET_KEY_PREVIOUS` and redeploy;
   - make the new key the only copy in Secrets Manager and the offline backup;
   - destroy the old key's copies.

Rollback:

- **Before step 5:** redeploy with the old key alone.
- **After step 5:** run `rotate-key --apply` with the keys swapped (`OLD` = new, `NEW` = old), then redeploy with the old key and the new one as previous.

Database backups made before step 5 need the old key; backups made after need the new key. Label backups with the key generation.

## Runbook: rotating Walrus delegate keys

- **Managed account** (`WALRUS_DELEGATE_KEY`):
  1. In the Walrus Memory dashboard, with the owner wallet, add a new delegate key.
  2. Put its private half in Secrets Manager only.
  3. Redeploy.
  4. Verify writes and recall (`buiry doctor`, a remember and recall, L-W1 on testnet).
  5. Remove the old delegate in the dashboard.

  Removing a delegate stops it fetching keys for new memories. Keys it already fetched still decrypt the memories they were fetched for (A26), so treat a leaked delegate as having exposed those memories.

- **A project's own account:** a project admin adds a new delegate in their Walrus Memory dashboard, then sets it on the Storage page ("Rotate key or edit"; same account, new key). The server re-seals it under the current `BUIRY_SECRET_KEY` and drops the cached adapter at once. The admin then removes the old delegate in their dashboard.
- **Order between rotations:** never rotate `BUIRY_SECRET_KEY` and a Walrus delegate in the same deploy. Finish one runbook, verify, then start the other.

## Who can read what on AWS

- The ECS execution role can read only the Buiry secrets and the RDS master secret (`infra/aws`, policy `read-secrets`). The task role has no secret access.
- People: the operator's AWS accounts, with MFA. CloudTrail records secret reads. Least-privilege IAM for people is the owner's decision.
- Logs: the server logs no secret. Startup errors name variables, never values.

## Mainnet

Separate keys for every network; never reuse testnet keys. The Mainnet cutover checklist is in HANDOFF section 10.
