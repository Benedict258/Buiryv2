# Deploying the private preview on one Oracle Cloud VM (Always Free)

**Everything in this guide is DESIGNED ONLY.** Nothing has been deployed to Oracle Cloud, and no step below has run there. The templates it installs are in `infra/oracle/`, with placeholders only. `docs/DEPLOY_RENDER.md` remains an alternative, and `docs/DEPLOYMENT.md` is the AWS design.

**Oracle's terms** are quoted from Oracle's Always Free resources page, https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (read 2026-11-26). Oracle's FAQ page (https://www.oracle.com/cloud/free/faq/) refused the fetch (HTTP 403). Anything the resources page does not state is marked UNVERIFIED.

## 0. Oracle's Always Free terms that matter here

| Topic         | What the page states                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AMD micro     | `VM.Standard.E2.1.Micro`, up to two instances: "1/8th of an OCPU with the ability to use additional CPU resources", "Memory: 1 GB"                                                                                                                                                                                                                                                                                        |
| Ampere A1     | `VM.Standard.A1.Flex`: "2 OCPUs total" and "12 GB total, which you can allocate flexibly". One instance with all of it, or "up to two instances of 1 OCPU each". "The first 1,500 OCPU hours and 9,000 GB hours per month for free". The A1 shape is arm64                                                                                                                                                                |
| Idle reclaim  | "Idle Always Free compute instances may be reclaimed by Oracle" if, during a 7-day period, "CPU utilization for the 95th percentile is less than 20%", "Network utilization is less than 20%" and "Memory utilization is less than 20% (applies to A1 shapes only)". What reclaiming does (stop, delete, notice) is not stated: UNVERIFIED. Whether it applies after upgrading to Pay As You Go is not stated: UNVERIFIED |
| Storage       | "A total of 200 GB of Block Volume storage, and five volume backups", shared by boot and block volumes. The default boot volume is given as 50 GB in one place and a 47 GB minimum in another. Object Storage: 20 GB total for Always Free accounts, and "50,000 Object Storage API requests per month"                                                                                                                   |
| Outbound data | "10 TB per month of outbound data"                                                                                                                                                                                                                                                                                                                                                                                        |
| A1 capacity   | Stated as sometimes unavailable: an "out of host capacity" error "indicates a temporary lack of Always Free shapes in your home region". Oracle suggests another availability domain, waiting, or upgrading to Pay As You Go                                                                                                                                                                                              |
| Region        | "You must create the Always Free compute instances in your home region"                                                                                                                                                                                                                                                                                                                                                   |

**Reclaim risk for this preview.** A quiet preview with few testers can easily stay under all three 20% thresholds for a week, so an Always Free VM running it may be reclaimed. Two things are UNVERIFIED: what reclaiming does, and whether a Pay As You Go account avoids it. **Owner's decision:** accept the risk with off-box backups (step 5), or use a Pay As You Go account. Do not run load just to stay above the thresholds.

## 1. Shape and memory budget

The **AMD micro (1 GB) is too small.** The build alone (`pnpm install`, the dashboard build and the server bundle) needs more than 1 GB. Node, Postgres 16 and the proxy would then compete for the rest, with swap as the only buffer.

**Use one Ampere A1 instance:** 2 OCPUs and 12 GB, or at least 1 OCPU and 6 GB. Estimated budget, **not measured** (UNVERIFIED for Buiry on this shape):

| Part                                                    | Estimate          | Note                                                               |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| Operating system and agents                             | about 0.5 GB      | Oracle Linux or Ubuntu, arm64                                      |
| Postgres 16                                             | about 1 GB        | `shared_buffers = 512MB`, `work_mem = 8MB`, `max_connections = 50` |
| Buiry server (`node dist-server/server.js`, every role) | about 0.5 to 1 GB | set `--max-old-space-size=768` in the unit if needed               |
| Caddy                                                   | about 0.1 GB      |                                                                    |
| Build (temporary, during upgrades)                      | about 2 GB        | stop nothing; the build runs beside the live server                |
| Headroom                                                | the rest          |                                                                    |

Boot volume: 50 GB (within the 200 GB). Add one block volume for `/var/lib/postgresql` and `/var/backups/buiry` if you want them to survive a rebuild of the boot volume.

## 2. Postgres 16 on the VM (no public port)

1. **Install** Postgres 16 server and client from the distribution's or PostgreSQL's arm64 packages. `pg_dump` and `pg_restore` must be major version 16, because `scripts/backup` refuses a different major.
2. **Listen on the loopback only.** In `postgresql.conf` set `listen_addresses = 'localhost'`. In `pg_hba.conf` keep only:

   ```
   local   all            postgres                     peer
   host    buiry          buiry          127.0.0.1/32  scram-sha-256
   host    buiry          buiry          ::1/128       scram-sha-256
   host    buiry          buiry_backup   127.0.0.1/32  scram-sha-256
   host    buiry_restore  buiry          127.0.0.1/32  scram-sha-256
   ```

   - **`buiry_backup`:** lets the nightly backup connect (step 5).
   - **`buiry_restore`:** lets the restore drill connect; the drill drops that database afterwards. These two lines were missing from the first version of this step (Phase 16c).

   No `0.0.0.0/0` line, and port 5432 stays closed in the security list and the host firewall (step 4).

3. **Database and roles (least privilege).** Run as `postgres` (`sudo -u postgres psql`):

   ```sql
   CREATE ROLE buiry_app NOLOGIN;                      -- the unprivileged role the server switches to for tenant queries (BD18)
   CREATE ROLE buiry LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
   GRANT buiry_app TO buiry;                           -- the server runs `set local role buiry_app`
   CREATE DATABASE buiry OWNER buiry;
   REVOKE ALL ON DATABASE buiry FROM PUBLIC;
   GRANT CONNECT ON DATABASE buiry TO buiry;
   CREATE ROLE buiry_backup LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   GRANT CONNECT ON DATABASE buiry TO buiry_backup;
   ```

   - **Why `buiry_app` is created here:** migration 003 (`003_rls`) creates `buiry_app` only if it does not exist, which needs `CREATEROLE`. Creating it first, as `postgres`, lets the login role `buiry` run without `CREATEROLE`.
   - **The backup role:** `buiry_backup` gets `pg_read_all_data` (`GRANT pg_read_all_data TO buiry_backup;`, Postgres 14 and later) for `pg_dump`.
   - **UNVERIFIED:** whether migrations 001 to 010 run cleanly under this exact role split. L-PG1 ran 001 to 009 on Postgres 16 with other roles. Run step 6.1 and check its output before inviting anyone.

4. **The connection string** goes only into the env file (step 3): `DATABASE_URL=postgres://buiry:<password>@127.0.0.1:5432/buiry`. It is a **secret**.

## 3. The app as a non-root user under systemd

1. **Users and directories.**

   ```sh
   sudo useradd --system --home /opt/buiry --shell /usr/sbin/nologin buiry
   sudo useradd --system --home /var/backups/buiry --shell /usr/sbin/nologin buiry-backup
   sudo mkdir -p /opt/buiry /etc/buiry /var/backups/buiry
   sudo chown buiry:buiry /opt/buiry
   sudo chown buiry-backup:buiry-backup /var/backups/buiry
   ```

2. **Build.** As `buiry`, with Node 22 and corepack. These are the same steps as the build stage of `Dockerfile`:

   ```sh
   git clone <repository> /opt/buiry/src && cd /opt/buiry/src && git checkout <commit>
   corepack enable && pnpm install --frozen-lockfile
   VITE_BUIRY_PREVIEW=1 pnpm --filter @buiry/dashboard exec vite build
   pnpm --filter @buiry/worker run build:server
   rm -rf /opt/buiry/app.new && pnpm --filter @buiry/worker deploy --prod --legacy --config.node-linker=hoisted /opt/buiry/app.new
   cp -r packages/worker/dist-server /opt/buiry/app.new/dist-server
   cp -r packages/chain/proto /opt/buiry/app.new/proto
   cp -r apps/dashboard/dist /opt/buiry/app.new/dashboard
   mv /opt/buiry/app /opt/buiry/app.prev 2>/dev/null; mv /opt/buiry/app.new /opt/buiry/app
   ```

   UNVERIFIED on arm64: whether every dependency installs and builds there. The image layout was verified without Docker on x86_64 (`docs/DEPLOYMENT.md`).

3. **Environment file**, outside the repo: `/etc/buiry/buiry.env`, owned by root, mode 600 (`sudo install -m 600 -o root -g root /dev/null /etc/buiry/buiry.env`). systemd reads it as root and passes it to the service. The `buiry` user cannot read the file itself. Names (values never in chat, issues, reports or commits):

   | Name                              | Value                                                                |
   | --------------------------------- | -------------------------------------------------------------------- |
   | `DATABASE_URL`                    | step 2.4 (**secret**)                                                |
   | `BUIRY_SECRET_KEY`                | `openssl rand -base64 48` (**secret**; `docs/KEY_CUSTODY.md`)        |
   | `BUIRY_BASE_URL`                  | `https://<your preview domain>`                                      |
   | `BUIRY_ALLOWED_ORIGINS`           | the same origin                                                      |
   | `BUIRY_TRUSTED_PROXY_HOPS`        | `1` (Caddy)                                                          |
   | `BUIRY_PREVIEW`                   | `1`                                                                  |
   | `BUIRY_MANAGED`                   | `off`                                                                |
   | `WALRUS_NETWORK`, `TATUM_NETWORK` | the same network, `testnet` or `mainnet`                             |
   | `TATUM_API_KEY`                   | the key for that network (**secret**)                                |
   | `TATUM_GRPC_ENDPOINT`             | required on testnet; on mainnet unset means Tatum's mainnet endpoint |
   | `BUIRY_MAILER`, `SMTP_*`          | step 7.1                                                             |

   **Must stay unset:**
   - `BUIRY_MANAGED_MULTI_TENANT`, `BUIRY_MANAGED_WORKSPACE_ID`, and the managed account names `WALRUS_RELAYER_URL`, `WALRUS_ACCOUNT_ID` and `WALRUS_DELEGATE_KEY`. Preview refuses to start with a managed workspace or multi-tenancy.
   - `BUIRY_BYO_ALLOW_PRIVATE` and `BUIRY_MAILER=console`, both refused in production.
   - The live-check names (`BYO_A_*`, `BYO_B_*`).

4. **Mainnet.** A mainnet preview needs `BUIRY_ALLOW_MAINNET=1`. `WALRUS_NETWORK=mainnet` and `TATUM_NETWORK=mainnet` must agree with every relayer host the server is given; the hosted mainnet relayer is `relayer.memory.walrus.xyz`. The server runs the same network check as the live scripts (`checkNetworkEnv`, BD48) before it opens the database. A mismatch, a missing network or mainnet without the opt-in stops it:

   ```
   [buiry] refusing to start, network mismatch: <the variables and hosts that disagree>
   ```

   The line names variables and hosts only, never values. systemd then shows the unit as failed (`systemctl status buiry`), and `journalctl -u buiry -n 50` shows the line. Never set `BUIRY_ALLOW_MAINNET` on a testnet server. Testers' mainnet accounts are refused without it.

5. **The unit.** Install `infra/oracle/buiry.service` as `/etc/systemd/system/buiry.service`. It:
   - runs as `buiry`, with `Restart=on-failure`;
   - stops retrying after 5 failures in 5 minutes, so a refusal stays visible;
   - is hardened with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and `PrivateTmp`.

   Then:

   ```sh
   sudo systemctl daemon-reload
   # Migrations, with the same environment as the service and no secret on a command line:
   sudo systemd-run --uid=buiry --property=EnvironmentFile=/etc/buiry/buiry.env \
     --working-directory=/opt/buiry/app --wait --pipe /usr/local/bin/node dist-server/migrate.js
   sudo systemctl enable --now buiry
   ```

## 4. TLS, reverse proxy and firewalls

1. **Caddy.** Install Caddy (arm64 package). Install `infra/oracle/Caddyfile.template` as `/etc/caddy/Caddyfile`, and set `BUIRY_DOMAIN=<your preview domain>` in Caddy's environment (`systemctl edit caddy`, `Environment=BUIRY_DOMAIN=...`). Point the domain's DNS at the VM's public IP first.
   - **TLS and redirect:** Caddy obtains the certificate and redirects HTTP to HTTPS by itself.
   - **Streaming:** `flush_interval -1` passes the live-update stream through at once.
   - **No access log:** the template has none, on purpose. Sign-in links carry a one-time token in the URL.
2. **Oracle security list** (or network security group) for the VM's subnet. Ingress rules:
   - TCP 443 from `0.0.0.0/0`;
   - TCP 80 from `0.0.0.0/0`, for the certificate challenge and the redirect;
   - TCP 22 **from your own address only** (`<your-ip>/32`).

   Nothing else, and in particular not 8787 or 5432.

3. **Host firewall.** Oracle's images ship a host firewall too, and it must agree. With `firewalld`: allow `http`, `https` and `ssh`, and nothing else. With `ufw`:

   ```sh
   sudo ufw default deny incoming
   sudo ufw allow from <your-ip> to any port 22 proto tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

   UNVERIFIED: which host firewall your chosen image uses. Whatever it is, the server's port 8787 must not be reachable from outside. It listens on every interface (`server.listen(port)`), so the firewall is what keeps it private.

4. **Check from outside the VM:**
   - `curl -I http://<domain>` redirects to `https://`;
   - `curl https://<domain>/v1/healthz` returns 200;
   - `curl --max-time 5 http://<public-ip>:8787/` times out;
   - `nc -vz <public-ip> 5432` fails.

## 5. Backups and the restore drill

**Reused from the repo:**

- `scripts/backup/backup.sh` (`pg_dump` custom format, checksum, metadata, `pg_restore --list` check, retention);
- `scripts/backup/restore.sh` (checksum check, version check, `pg_restore --clean --if-exists`, row counts).

Both accept a local `file:///dir` store as well as `s3://`. Backups and restore were verified on Postgres 16 with test data (L-BAK1, 2026-11-21), not on Oracle.

1. **Schedule.** Install the templates and the backup environment:

   ```sh
   sudo install -m 600 -o root -g root /dev/null /etc/buiry/backup.env   # DATABASE_URL (buiry_backup), BACKUP_DIR=/var/backups/buiry,
                                                                          # BACKUP_RETENTION_DAYS=14, OCI_BACKUP_BUCKET, BUIRY_SRC=/opt/buiry/src
   sudo cp /opt/buiry/src/infra/oracle/buiry-backup.service /opt/buiry/src/infra/oracle/buiry-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now buiry-backup.timer
   ```

   - **Timing:** the timer runs nightly at 03:30 UTC, give or take 15 minutes, and catches up after downtime.
   - **What the wrapper does:** `infra/oracle/backup-local.sh` runs `backup.sh` against `file:///var/backups/buiry`, then copies the directory to Object Storage.

2. **Retention.** Local: `BACKUP_RETENTION_DAYS` (14 suggested). Off-box: an Object Storage lifecycle rule on the bucket deleting objects older than 30 days (the owner's choice), within the 20 GB Always Free total. With retention, a small preview database stays far below that, but the size is UNVERIFIED until measured.
3. **Off-box copy.**
   - The wrapper runs `oci os object bulk-upload --bucket-name "$OCI_BACKUP_BUCKET" --src-dir "$BACKUP_DIR" --include 'buiry-*' --no-overwrite`.
   - It needs the OCI CLI configured for `buiry-backup`, with an API key that can write only to that bucket.
   - **UNVERIFIED:** the exact CLI flags and policy, which have not run.
   - **Why it's required:** a backup that stays on the VM is lost with the VM. That matters here because Oracle may reclaim idle instances (section 0).
4. **Restore drill** (on a schedule the owner sets, into a scratch database, never the live one):

   ```sh
   sudo -u postgres createdb -O buiry buiry_restore
   sudo -u buiry-backup env BACKUP_S3_URI=file:///var/backups/buiry \
     RESTORE_DATABASE_URL=postgres://buiry:<password>@127.0.0.1:5432/buiry_restore \
     bash /opt/buiry/src/scripts/backup/restore.sh
   # then migrate the restored copy and compare row counts with the live database
   # UNVERIFIED: whether migrate.js needs settings beyond DATABASE_URL.
   sudo systemd-run --uid=buiry \
     --property=Environment=DATABASE_URL=postgres://buiry:<password>@127.0.0.1:5432/buiry_restore \
     --working-directory=/opt/buiry/app --wait --pipe /usr/local/bin/node dist-server/migrate.js
   sudo -u postgres dropdb buiry_restore
   ```

   - **Pass:** `restore.sh` prints `checksum ok`, `versions ok`, and row counts equal to the live database at the dump's time.
   - **Fetching first:** to drill from the off-box copy, download the newest dump, its `.sha256` and `.json` into a scratch directory first, and point `BACKUP_S3_URI` at it.
   - **Keep the password off command lines:** these lines put a password on a command line; on a VM with other users, put it in a mode-600 file and source it instead.

## 6. The token migration dry run on the first deployed database (L-TOK1)

1. After the first `migrate.js` run (step 3.5), check `GET /v1/healthz` returns 200 through Caddy.
2. **Dry run**, on the VM, from the source checkout, against the local database. A loopback host is accepted without `BUIRY_SEED_ALLOW_REMOTE`:

   ```sh
   cd /opt/buiry/src
   sudo systemd-run --uid=buiry --property=EnvironmentFile=/etc/buiry/buiry.env --working-directory=/opt/buiry/src \
     --wait --pipe pnpm tsx scripts/real-pg/token-expiry.ts
   ```

   It prints counts by scope only: never a token, a hash, a name or an id.

3. **Send the output to the owner.** Run it again with `--apply` only after the owner's go-ahead. Until then finding M4 stays partly fixed (`docs/SECURITY_REVIEW.md`).

## 7. Mail, logs, health, upgrade and rollback

1. **SMTP.** Set:
   - `BUIRY_MAILER=smtp`;
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (`1` for implicit TLS on 465);
   - `SMTP_REQUIRE_TLS`: leave unset; `0` is refused in production;
   - `SMTP_USER`, `SMTP_PASSWORD` (**secret**), `SMTP_FROM`.

   Oracle may restrict outbound port 25, so use 465 or 587 with your provider; this is UNVERIFIED on Oracle. Check: request a sign-in link for your own address and open it once (L-M1).

2. **Log redaction check.** Export a day of the server's journal and scan it against the env file with the repo's secret guard, each file on its own:

   ```sh
   sudo journalctl -u buiry --since today -o cat > /tmp/buiry-journal.txt
   # As root, since only root can read the env file; the guard prints variable names and file names, never values.
   sudo node /opt/buiry/src/node_modules/tsx/dist/cli.mjs /opt/buiry/src/scripts/secret-guard.ts \
     --env /etc/buiry/buiry.env /tmp/buiry-journal.txt
   sudo shred -u /tmp/buiry-journal.txt
   ```

   Pass: `clean`. Also check that no line contains `?token=`. Caddy keeps no access log, and the server logs the route pattern, not the URL (`docs/DEPLOY_RENDER.md`, Logs).

3. **Health.** `curl -fsS https://<domain>/v1/healthz` returns 200 with `{"status":"ok"}` and the Sui network. `systemctl is-active buiry caddy postgresql` prints `active` three times.
4. **Upgrade.**
   1. Backup now: `sudo systemctl start buiry-backup` and check it succeeded.
   2. Build the new commit into `/opt/buiry/app.new` (step 3.2), keeping `app.prev`.
   3. Run `migrate.js` from the new build (step 3.5).
   4. `sudo systemctl restart buiry`.
   5. Health check.
5. **Rollback.**
   - **When the new build fails health:** `sudo systemctl stop buiry && mv /opt/buiry/app /opt/buiry/app.bad && mv /opt/buiry/app.prev /opt/buiry/app && sudo systemctl start buiry`, then a health check.
   - **Schema changes:** migrations are forward-only. If the new version's migration changed the schema, an old build may refuse the newer schema. Then restore the pre-upgrade dump into a scratch database (step 5.4) and switch to it, as the owner decides.

## 8. Testers

- **Each tester brings their own Walrus account (BYO).** The preview has no shared account (`BUIRY_MANAGED=off`). A project's writes are refused until it connects its own account on the server's network. Setup is in `docs/TESTER_ONBOARDING.md`.
- **Chain checks share one Tatum key.** Every tester's chain verification goes through the server's single Tatum key, so many testers at once may hit Tatum's limit. Tatum's free-plan figures disagree between its own pages (3 or 5 requests per second; 100,000 or 1,000,000 credits; A32), so the actual limit is UNVERIFIED. When it is hit, chain checks report `unknown`, never a pass.

## 9. Pre-go-live checklist

Every item is **NOT RUN**. Mark each PASS or FAIL when it has run on the VM, with the date.

| #   | Item                                                                                                                                         | Result  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Ampere A1 instance created in the home region (not the 1 GB micro)                                                                           | NOT RUN |
| 2   | Postgres 16 listens on localhost only; `pg_hba.conf` has no remote line                                                                      | NOT RUN |
| 3   | Roles `buiry` (no superuser, createdb or createrole), `buiry_app` (nologin) and `buiry_backup` created; database owned by `buiry`            | NOT RUN |
| 4   | Build completes on arm64 from a pinned commit                                                                                                | NOT RUN |
| 5   | `/etc/buiry/buiry.env` is root-owned, mode 600, outside the repo; `BUIRY_PREVIEW=1`, `BUIRY_MANAGED=off`, `BUIRY_MANAGED_MULTI_TENANT` unset | NOT RUN |
| 6   | Networks agree; mainnet only with `BUIRY_ALLOW_MAINNET=1`; startup log shows no "refusing to start"                                          | NOT RUN |
| 7   | `migrate.js` ran migrations 001 to 010 cleanly under the role split (step 2.3)                                                               | NOT RUN |
| 8   | `buiry.service` active as user `buiry`; restarts after `kill`; stops retrying after 5 refusals                                               | NOT RUN |
| 9   | Caddy serves HTTPS with a valid certificate; HTTP redirects to HTTPS; no access log                                                          | NOT RUN |
| 10  | Security list: only 80, 443 and SSH from a restricted source; host firewall agrees                                                           | NOT RUN |
| 11  | From outside: 8787 and 5432 unreachable; `/v1/healthz` 200 through Caddy                                                                     | NOT RUN |
| 12  | Nightly backup ran; dump, checksum and metadata present locally and in Object Storage                                                        | NOT RUN |
| 13  | Restore drill into a scratch database: checksum ok, versions ok, row counts match                                                            | NOT RUN |
| 14  | Token migration dry run (L-TOK1) output sent to the owner; `--apply` only on the owner's go                                                  | NOT RUN |
| 15  | SMTP: sign-in email received and the link works once (L-M1)                                                                                  | NOT RUN |
| 16  | Log redaction: the secret guard reports clean on a day of the journal; no `?token=` in any log                                               | NOT RUN |
| 17  | Upgrade and rollback rehearsed once                                                                                                          | NOT RUN |
| 18  | Owner's own account connected on the server's network and one memory written end to end; on mainnet only after a canary passed               | NOT RUN |
| 19  | Owner decision recorded on the idle-reclaim risk (section 0)                                                                                 | NOT RUN |
| 20  | 1 GB profile: 2 GB swap active, swappiness 10 (10.2)                                                                                         | NOT RUN |
| 21  | 1 GB profile: Postgres settings from 10.3 in effect (`show shared_buffers`, `max_connections`, `listen_addresses`)                           | NOT RUN |
| 22  | 1 GB profile: unit runs with `--max-old-space-size=256`, `MemoryHigh=400M`, `MemoryMax=450M` (10.4)                                          | NOT RUN |
| 23  | Artefact built off the VM; checksum verified on the VM; MANIFEST commit matches (10.5)                                                       | NOT RUN |
| 24  | First checks recorded: free memory, swap, Postgres memory, idle service memory (10.9)                                                        | NOT RUN |
| 25  | Firewall: only ACCEPT rules for 80 and 443 added; port 22 rules untouched; 8787 unreachable from outside (10.6.9)                            | NOT RUN |
| 26  | Rebuild-from-backup rehearsed on a fresh VM (10.8)                                                                                           | NOT RUN |

## 10. The 1 core, 1 GB profile

The AMD micro shape (1/8 OCPU, 1 GB) is too small to **build** on (section 1), but it can **run** Buiry if the build happens elsewhere and the limits below hold. Everything in this section is DESIGNED ONLY, except the numbers labelled LOCAL MEASUREMENT.

### 10.1 Memory budget

| Part                                                                 | Figure                                                                                                                                                                       | Label                                                                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Buiry server, every role in one process (`BUIRY_ROLE` unset = `all`) | JS heap 35 to 55 MB; process RSS 319 to 392 MB idle, of which 240 to 480 MB is the in-process test database (PGlite); the server's own share is therefore about 90 to 150 MB | LOCAL MEASUREMENT (Windows x64, Node 24, built `dist-server/server.js`, PGlite, 500 requests of smoke load added 2 to 4 MB); the server's own share is an estimate |
| Startup peak with PGlite                                             | 1.02 to 1.15 GB                                                                                                                                                              | LOCAL MEASUREMENT; PGlite's start, not present with a real Postgres                                                                                                |
| Buiry server with `--max-old-space-size=256`                         | served the same load; heap about 35 MB                                                                                                                                       | LOCAL MEASUREMENT                                                                                                                                                  |
| Postgres 16 with 10.3's settings                                     | about 150 to 250 MB (128 MB shared buffers plus up to 10 connections)                                                                                                        | estimate                                                                                                                                                           |
| Operating system                                                     | about 150 to 250 MB                                                                                                                                                          | estimate; measure with 10.8                                                                                                                                        |
| Caddy                                                                | about 30 MB, or none while there is no domain                                                                                                                                | estimate                                                                                                                                                           |
| Swap                                                                 | 2 GB file, a buffer for spikes                                                                                                                                               | 10.2                                                                                                                                                               |

**Worker in the API process.** It already is one process: `BUIRY_ROLE` defaults to `all`, which runs the HTTP server and the background jobs together. No new mode is needed.

**Dashboard.** The built preview dashboard is 594 KB in 9 files (LOCAL MEASUREMENT). A proxy could serve it as static files, with a fallback to `index.html` for client routes. The server already does this, adding its security headers (CSP), so a proxy serving the files itself would have to set the same headers. Keep the server serving it.

**Native modules.** The production dependencies (`pnpm deploy --prod`, 75 MB, 8,625 files) contain no `.node` file, no `binding.gyp`, no prebuilds and no OS or CPU restriction. The only install script is `protobufjs`'s, which prints a version notice (LOCAL MEASUREMENT). So one artefact runs on x86_64 and arm64.

### 10.2 Swap

`infra/oracle/swap.sh` (run once with `sudo bash`):

- creates a 2 GB `/swapfile` only if no swap is active;
- makes it permanent in `/etc/fstab`;
- sets `vm.swappiness=10`, so swap absorbs spikes rather than holding working memory.

Two GB is twice RAM: enough for one spike in each of the server and Postgres, small against the 47 to 50 GB boot volume.

### 10.3 Postgres 16 tuned for 1 GB

`infra/oracle/postgresql-1gb.conf.template`, installed as `/etc/postgresql/16/main/conf.d/90-buiry-1gb.conf`:

| Setting                                        | Value          | Reason                                                                                             |
| ---------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `listen_addresses`                             | `localhost`    | no remote client, no public port                                                                   |
| `max_connections`                              | 20             | the server's pool opens at most 10 (the `pg` default); the rest for migrations, backups and `psql` |
| `shared_buffers`                               | 128MB          | about 1/8 of RAM                                                                                   |
| `effective_cache_size`                         | 384MB          | planner hint: the OS page cache is small too                                                       |
| `work_mem`                                     | 4MB            | per sort or hash; small queries                                                                    |
| `maintenance_work_mem`                         | 32MB           | vacuum and index builds without crowding the server                                                |
| `huge_pages`                                   | off            | none reserved on a small VM                                                                        |
| `jit`                                          | off            | costs memory and start-up time; no gain for small queries                                          |
| `autovacuum_max_workers`                       | 2              | one core                                                                                           |
| `max_wal_size` / `min_wal_size`                | 256MB / 64MB   | small disk budget                                                                                  |
| `log_statement` / `log_min_duration_statement` | none / 2000 ms | no statement text in logs (it can carry data); slow statements only                                |

### 10.4 Node limits

`infra/oracle/buiry.service` runs `/usr/local/bin/node --max-old-space-size=256 dist-server/server.js`. Memory limits:

- `MemoryHigh=400M` throttles the service above 400 MB;
- `MemoryMax=450M` kills it there, and `Restart=on-failure` brings it back.

That stops the server from pushing Postgres into swap. On a larger shape, raise all three.

### 10.5 Build off the VM: the artefact

**Never build on the 1 GB VM.** On the build machine, from a clean checkout of the commit to deploy:

```sh
bash infra/oracle/build-artifact.sh          # writes .artifact/buiry-<commit>.tar.gz and .sha256
```

**What it contains:**

- production dependencies only (`pnpm deploy --prod`, hoisted);
- the built server, protos and preview dashboard;
- `pnpm-lock.yaml`;
- `ops/` (`scripts/backup` and these templates);
- a `MANIFEST` (commit, build Node version, file count).

It refuses a dirty tree, any env file or key in the artefact, and any workspace dev tool (`typescript`, `tsx`, `vitest`) that no production package requires (`infra/oracle/check-artifact-deps.cjs`). `typescript` stays, because production packages list it as a peer and pnpm installs it with them; the Docker image ships it the same way.

**On the VM:**

```sh
scp -i <key> .artifact/buiry-<commit>.tar.gz .artifact/buiry-<commit>.tar.gz.sha256 <user>@<vm>:/tmp/
# on the VM:
cd /tmp && sha256sum -c buiry-<commit>.tar.gz.sha256
sudo rm -rf /opt/buiry/app.new && sudo mkdir -p /opt/buiry/app.new
sudo tar -xzf /tmp/buiry-<commit>.tar.gz -C /opt/buiry/app.new --strip-components=1
sudo chown -R root:buiry /opt/buiry/app.new && sudo chmod -R g+rX,o-rwx /opt/buiry/app.new
[ -d /opt/buiry/app ] && sudo mv /opt/buiry/app /opt/buiry/app.prev; sudo mv /opt/buiry/app.new /opt/buiry/app
```

The app files are owned by root and readable by the `buiry` group, so the service cannot change its own code.

### 10.6 Install on the VM (Ubuntu), in order

Each command is listed here so nothing else runs with `sudo`. First, read-only facts: `cat /etc/os-release`, `uname -m`, `free -m`, `df -h /`, `swapon --show`, `command -v psql node caddy`.

1. **Swap:** copy `ops/infra/oracle/swap.sh` from the artefact, or the repo, then `sudo bash swap.sh`.
2. **Postgres 16:**
   - **Ubuntu 24.04:** `sudo apt-get update && sudo apt-get install -y postgresql-16`.
   - **Ubuntu 22.04:** add PostgreSQL's own repository first: `sudo apt-get install -y postgresql-common && sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh`, then the same install. UNVERIFIED: the script's prompts.

   Then:
   - `sudo install -m 644 ops/infra/oracle/postgresql-1gb.conf.template /etc/postgresql/16/main/conf.d/90-buiry-1gb.conf`;
   - in `/etc/postgresql/16/main/pg_hba.conf`, keep only the lines in step 2.2;
   - `sudo systemctl restart postgresql`.

3. **Node 20** from nodejs.org, checked against its published checksum (no third-party apt repository):

   ```sh
   NA=$(case "$(dpkg --print-architecture)" in amd64) echo x64;; arm64) echo arm64;; esac)
   cd /tmp && curl -fsSLO https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt
   F=$(grep -oE "node-v20\.[0-9]+\.[0-9]+-linux-$NA\.tar\.xz" SHASUMS256.txt | head -1)
   curl -fsSLO "https://nodejs.org/dist/latest-v20.x/$F" && grep " $F\$" SHASUMS256.txt | sha256sum -c -
   sudo tar -xJf "$F" -C /opt && sudo ln -sfn "/opt/${F%.tar.xz}" /opt/node && sudo ln -sfn /opt/node/bin/node /usr/local/bin/node
   ```

   The checksum file's signature is not checked: UNVERIFIED beyond the HTTPS download.

4. **Users and directories:** as in step 3.1, with `/opt/buiry` owned by root (the app is not writable by `buiry`).
5. **Database and roles:** step 2.3. Generate each password on the VM and pass it to `psql` as a variable, never on screen:

   ```sh
   DBPW=$(openssl rand -hex 24); BKPW=$(openssl rand -hex 24)
   sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$DBPW" -v bkpw="$BKPW" <<'SQL'
   CREATE ROLE buiry_app NOLOGIN;
   CREATE ROLE buiry LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
   GRANT buiry_app TO buiry;
   CREATE DATABASE buiry OWNER buiry;
   REVOKE ALL ON DATABASE buiry FROM PUBLIC;
   GRANT CONNECT ON DATABASE buiry TO buiry;
   CREATE ROLE buiry_backup LOGIN PASSWORD :'bkpw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   GRANT CONNECT ON DATABASE buiry TO buiry_backup;
   GRANT pg_read_all_data TO buiry_backup;
   SQL
   ```

6. **Env files,** created on the VM, root-owned, mode 600, outside the app directory:
   - **`/etc/buiry/buiry.env`:**
     - the generated `DATABASE_URL` and `BUIRY_SECRET_KEY` (`openssl rand -base64 48`);
     - the preview settings `BUIRY_PREVIEW=1`, `BUIRY_MANAGED=off` and `BUIRY_MAILER=smtp`;
     - the network `WALRUS_NETWORK` and `TATUM_NETWORK`, with `BUIRY_ALLOW_MAINNET=1` only for mainnet;
     - **empty** `TATUM_API_KEY`, `SMTP_*`, `BUIRY_BASE_URL` and `BUIRY_ALLOWED_ORIGINS` for the owner to fill.
   - **`/etc/buiry/backup.env`:** the `buiry_backup` `DATABASE_URL`, `BACKUP_DIR=/var/backups/buiry`, `BACKUP_RETENTION_DAYS=14`, `BUIRY_SRC=/opt/buiry/app/ops` and an empty `OCI_BACKUP_BUCKET`.

   Exact commands, in the **same shell session as step 5**, so `DBPW` and `BKPW` carry over and no value is ever printed. Use the mainnet lines only for a mainnet preview; otherwise set `testnet` and leave `BUIRY_ALLOW_MAINNET` out.

   ```sh
   KEY=$(openssl rand -base64 48 | tr -d '\n'); DOMAIN=<your preview domain>
   sudo install -d -m 755 /etc/buiry
   sudo install -m 600 -o root -g root /dev/null /etc/buiry/buiry.env
   sudo install -m 600 -o root -g root /dev/null /etc/buiry/backup.env
   sudo tee /etc/buiry/buiry.env >/dev/null <<EOF
   DATABASE_URL=postgres://buiry:$DBPW@127.0.0.1:5432/buiry
   BUIRY_SECRET_KEY=$KEY
   BUIRY_BASE_URL=https://$DOMAIN
   BUIRY_ALLOWED_ORIGINS=https://$DOMAIN
   BUIRY_TRUSTED_PROXY_HOPS=1
   BUIRY_PREVIEW=1
   BUIRY_MANAGED=off
   WALRUS_NETWORK=mainnet
   TATUM_NETWORK=mainnet
   BUIRY_ALLOW_MAINNET=1
   TATUM_API_KEY=
   BUIRY_MAILER=smtp
   SMTP_HOST=
   SMTP_PORT=
   SMTP_SECURE=
   SMTP_USER=
   SMTP_PASSWORD=
   SMTP_FROM=
   EOF
   sudo tee /etc/buiry/backup.env >/dev/null <<EOF
   DATABASE_URL=postgres://buiry_backup:$BKPW@127.0.0.1:5432/buiry
   BACKUP_DIR=/var/backups/buiry
   BACKUP_RETENTION_DAYS=14
   BUIRY_SRC=/opt/buiry/app/ops
   OCI_BACKUP_BUCKET=
   EOF
   unset DBPW BKPW KEY
   ```

   `sudo tee` writes into the existing root-owned mode-600 files, keeping the mode. `BUIRY_TRUSTED_PROXY_HOPS=1` assumes Caddy in front.

7. **Artefact:** 10.5.
8. **Unit and timer:** copy `buiry.service`, `buiry-backup.service` and `buiry-backup.timer` from `ops/infra/oracle/` to `/etc/systemd/system/`, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now buiry-backup.timer`. Do **not** enable or start `buiry` until the owner has filled the values. Until `OCI_BACKUP_BUCKET` is set, each nightly run makes the local dump and then fails on purpose (`OFF-BOX COPY NOT CONFIGURED`).
9. **Firewall (80 and 443 only; never touch port 22).**
   - **Read-only look first:** `sudo iptables -S INPUT` and `sudo ufw status`.
   - **If `ufw` is inactive and `INPUT` ends in a `REJECT` rule** (the layout this step assumes, UNVERIFIED until seen), insert the two accepts just before that rule and save:

     ```sh
     N=$(sudo iptables -L INPUT --line-numbers -n | awk '$2=="REJECT" {print $1; exit}')
     sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport 443 -j ACCEPT
     sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport 80 -j ACCEPT
     sudo netfilter-persistent save
     ```

   - **Any other layout:** stop and ask.
   - **Cloud side:** the VCN security list rules for 80 and 443 are added in the Oracle console by the owner.
   - **Port 8787:** gets no rule and stays unreachable.
10. **Migrations** (before the first start, step 3.5): `sudo systemd-run --uid=buiry --property=EnvironmentFile=/etc/buiry/buiry.env --working-directory=/opt/buiry/app --wait --pipe /usr/local/bin/node dist-server/migrate.js`.
11. **Restore drill** on the new database, step 5.4. The backup part runs as `sudo systemctl start buiry-backup` and makes the local dump. Its non-zero exit until off-box is configured is expected. Exact commands, with no password on a command line:

    ```sh
    sudo systemctl start buiry-backup || true            # local dump; exits 3 until OCI_BACKUP_BUCKET is set
    sudo -u postgres createdb -O buiry buiry_restore
    sudo install -m 600 -o root -g root /dev/null /etc/buiry/restore.env
    sudo sh -c 'sed -n "s#^DATABASE_URL=\(.*\)/buiry\$#RESTORE_DATABASE_URL=\1/buiry_restore#p" /etc/buiry/buiry.env > /etc/buiry/restore.env; echo BACKUP_S3_URI=file:///var/backups/buiry >> /etc/buiry/restore.env'
    sudo systemd-run --uid=buiry-backup --property=EnvironmentFile=/etc/buiry/restore.env --wait --pipe bash /opt/buiry/app/ops/scripts/backup/restore.sh
    sudo -u postgres psql -d buiry_restore -Atc "select count(*) from schema_migrations"
    sudo -u postgres dropdb buiry_restore
    sudo rm -f /etc/buiry/restore.env
    ```

12. **L-TOK1 on the 1 GB profile.** The VM has no source checkout, so run the dry run from the build machine through an SSH tunnel: `ssh -i <key> -L 15432:127.0.0.1:5432 <user>@<vm>`, then `DATABASE_URL=postgres://buiry:<password>@127.0.0.1:15432/buiry pnpm tsx scripts/real-pg/token-expiry.ts` (a loopback host needs no override). UNVERIFIED: this path has not run.

### 10.7 External managed Postgres (an option, not chosen)

Postgres can run off the VM, at a managed provider, reached over TLS (`sslmode=require` in `DATABASE_URL`).

|                  | On the VM (this guide)       | Managed, elsewhere                                             |
| ---------------- | ---------------------------- | -------------------------------------------------------------- |
| Memory on the VM | about 150 to 250 MB          | none                                                           |
| Backups          | this guide's timer and drill | the provider's, plus this guide's dumps if wanted              |
| Latency          | loopback                     | network round trip per query                                   |
| Dependencies     | none                         | a second provider, its limits and terms (UNVERIFIED)           |
| Least privilege  | step 2.3                     | depends on what the provider allows (for example `CREATEROLE`) |

Oracle's Always Free list includes Autonomous AI Database, not PostgreSQL.

### 10.8 Reclaim risk on the micro shape, and the disposable VM

**Thresholds.** For the AMD micro shape, the idle thresholds that apply are CPU (95th percentile under 20%) and network (under 20%) over 7 days. The memory threshold applies to A1 shapes only. A quiet preview may meet both, so the VM may be reclaimed. What reclaiming does is UNVERIFIED.

**Treat the VM as disposable.** Everything needed to rebuild it is:

- this repository at a known commit, which builds the artefact;
- the two env files' values, which the owner keeps outside the VM;
- the latest off-box dump.

**Rebuild from backup** (DESIGNED ONLY, NOT RUN):

1. Create a new VM.
2. Run 10.6 steps 1 to 9.
3. Download the newest dump, `.sha256` and `.json` from Object Storage into `/var/backups/buiry`.
4. Run `restore.sh` into the new `buiry` database (`RESTORE_DATABASE_URL`, `BACKUP_S3_URI=file:///var/backups/buiry`).
5. Run the migrations (10.6.10).
6. Start the service.
7. Check health.
8. Point DNS at the new address.

### 10.9 First checks on the VM (names and numbers only)

| Check                                           | Command                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Memory                                          | `free -m`                                                                                       |
| Swap                                            | `swapon --show` and `cat /proc/sys/vm/swappiness`                                               |
| Postgres memory                                 | `ps -o rss= -C postgres \| awk '{s+=$1} END {print s/1024 " MB"}'`                              |
| Postgres settings                               | `sudo -u postgres psql -Atc "show shared_buffers; show max_connections; show listen_addresses"` |
| Idle service memory (after the owner starts it) | `systemctl show buiry -p MemoryCurrent`                                                         |
| Listening ports                                 | `sudo ss -ltn` (5432 on 127.0.0.1 only; 8787 only while the service runs)                       |

### 10.10 Ubuntu 26.04 LTS (`resolute`)

**What the VM is** (RAN ON VM, read-only: `/etc/os-release`, `uname -m`, `free -m`, `df`, `swapon`, `apt-cache policy`, 2026-11-26):

| Item                  | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| OS                    | Ubuntu 26.04.1 LTS, codename `resolute`, x86_64 (AMD micro)        |
| Memory and swap       | 951 MB total; no swap                                              |
| Ubuntu's own packages | `postgresql` 18 only (no `postgresql-16`); no `nodejs`; no `caddy` |
| Firewall tool         | `netfilter-persistent` present, `ufw` absent: use 10.6.9           |

**Postgres 16 comes from PostgreSQL's own apt repository (PGDG), not Ubuntu's archive.**

- **Check method** (read-only, from the build machine): GET `https://apt.postgresql.org/pub/repos/apt/dists/resolute-pgdg/Release` (component `16`, architecture `amd64` listed) and `.../main/binary-amd64/Packages.gz` (newest `postgresql-16` is `16.16-1.pgdg26.04+1`; read 2026-11-26).
- **Signing key.** The key is `https://apt.postgresql.org/pub/repos/apt/ACCC4CF8.asc`. Its fingerprint must equal the one published on https://www.postgresql.org/download/linux/ubuntu/: `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`. On the VM:

  ```sh
  curl -fsS https://apt.postgresql.org/pub/repos/apt/ACCC4CF8.asc -o /tmp/pgdg.asc
  gpg --show-keys --with-colons /tmp/pgdg.asc | awk -F: '/^fpr:/ {print $10; exit}'   # stop unless B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
  sudo install -d -m 755 /etc/apt/keyrings
  sudo install -m 644 /tmp/pgdg.asc /etc/apt/keyrings/pgdg.asc
  echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt resolute-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
  sudo apt-get update && sudo apt-get install -y postgresql-16
  ```

  Then continue with 10.6 step 2: the tuned settings and `pg_hba.conf`. Never install Ubuntu's Postgres 18 beside it: Buiry is verified on 16 (L-PG1, L-BAK1), and the backup scripts need `pg_dump` of the server's major version.

**Node 20** comes from nodejs.org (10.6.3); Ubuntu 26.04 does not package Node.

**Caddy.**

- **Install** only from its official repository (`https://dl.cloudsmith.io/public/caddy/stable/`), and only after its signing key is checked against a fingerprint Caddy publishes.
- **The check failed to complete on 2026-11-26.** The key file's fingerprint is `65760C51EDEA2017CEA2CA15155B6D79CA56EA34` (computed). But neither https://caddyserver.com/docs/install nor https://github.com/caddyserver/dist states a fingerprint, and the Cloudsmith setup page refused automated requests (HTTP 405).
- **So Caddy stays NOT INSTALLED** until the owner confirms the fingerprint from a source Caddy controls. Without Caddy there is no TLS, so the service must not be exposed.
