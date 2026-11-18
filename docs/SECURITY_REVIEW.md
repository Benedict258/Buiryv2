# Security review

Scope: the code on `main` as of commit `83b58e9` (API server, MCP HTTP transport, auth, webhooks, packs, dashboard static serving, dashboard React code). Method: reading the code and running targeted tests. This is an internal review, not a penetration test or an external audit.

Severity: **critical** = remote compromise or cross-tenant data access without credentials; **high** = an unauthenticated attacker can take the service down or obtain a credential; **medium** = needs a precondition (a deployment choice, a valid account, a network position) or limits damage poorly; **low** = hardening.

## Summary

| ID  | Severity | Finding                                                                    | Status                                             |
| --- | -------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| H1  | high     | Malformed URL escape threw inside the raw request listener                 | Fixed in `83b58e9`, regression test                |
| H2  | high     | No request body size limit (REST and MCP), unauthenticated routes included | Fixed in `83b58e9`, regression tests               |
| H3  | high     | Sign-in links (bearer secrets) printed to logs when no mailer is set       | Fixed in `83b58e9` for production, regression test |
| M1  | medium   | Rate limiter keys on the first `X-Forwarded-For` entry                     | Fixed (trusted proxy hops, tested)                 |
| M2  | medium   | Webhook destination check: DNS rebinding window, missing reserved ranges   | Fixed (pinned connection, tested)                  |
| M3  | medium   | No cap on concurrent SSE streams; streams outlive a revoked session        | Fixed (caps and session re-check, tested)          |
| M4  | medium   | Agent tokens never expire; API token expiry is optional and off by default | Fixed for new agent tokens (expiry, tested)        |
| M5  | medium   | Unexpected (500) errors are not logged                                     | Fixed (logged without messages, tested)            |
| M6  | medium   | Production can start on an in-memory database                              | Fixed (production startup check, tested)           |
| M7  | medium   | No item count cap on pack import (only the 2 MiB body cap from H2)         | Fixed (item, text and evidence caps, tested)       |
| L1  | low      | MCP sessions live in process memory with no idle expiry                    | Fixed (30-minute idle expiry, tested)              |
| L2  | low      | Dashboard static path check used a bare prefix match                       | Fixed in `83b58e9` (separator-aware)               |

No critical findings.

## High

### H1: malformed URL crashed the request handler

- **Evidence:** `packages/api/src/server.ts`, `serveStatic` called `decodeURIComponent` on the path from inside Node's raw `createServer` listener, outside any try/catch, whenever `DASHBOARD_DIR` is set.
- **Exploit:** `GET /%E0%A4%A` throws `URIError: URI malformed`. Under the vitest run the request never got a response (20 s timeout); in a plain Node process an uncaught exception in the listener stops the server. Unauthenticated, one request.
- **Fix:** the decode is guarded and answers 400. The containment check now requires the resolved file to equal the root or sit under `root + path separator` (L2).
- **Test:** `packages/api/test/static.test.ts`, "answers a malformed percent escape with 400 and keeps serving" (fails on the previous code with `URIError`).

### H2: unbounded request bodies

- **Evidence:** `packages/api/src/http/context.ts` `body()` called `c.req.text()`; `packages/mcp/src/http.ts` `readJson` buffered every chunk. Both run before authentication on some routes (`/v1/auth/email/start`, and `/mcp` reads the body before the token is checked against the database).
- **Exploit:** an unauthenticated client streams hundreds of megabytes to `/v1/auth/email/start` or `/mcp`; the process buffers it all and runs out of memory.
- **Fix:** REST bodies are read through `readCapped` with `MAX_BODY_BYTES` (2 MiB, checked against `Content-Length` and while streaming). MCP bodies are capped at `MAX_MCP_BODY_BYTES` (1 MiB) and refused with 413; invalid MCP JSON now returns 400 instead of 500.
- **Tests:** `static.test.ts`, "refuses a REST body over the cap, declared or streamed without a length" and "refuses an MCP body over the cap with 413 before authenticating".
- **Note:** an oversized REST body returns `invalid_input` (400), not 413, to avoid adding an error code to the public protocol.

### H3: sign-in links in logs

- **Evidence:** `packages/api/src/server.ts`, `ConsoleMailer` logs the full magic link (`/auth/email?token=...`) and was selected whenever `BUIRY_MAILER` was unset, including in production.
- **Exploit:** anyone with read access to production logs (log aggregation, a support engineer, a leaked log export) signs in as any user who requested a link in the last 15 minutes.
- **Fix:** `mailerFromEnv` never returns the console mailer when `NODE_ENV=production`; production without a configured mailer refuses email sign-in with a clear error and logs nothing. Development still prints links. The SMTP mailer (Phase 7) keeps the same rule: the link goes only into the message body; errors and logs never contain it or the SMTP password (tested with a fake SMTP server).
- **Test:** `static.test.ts`, "never uses the console mailer in production" (asserts the mailer type, the refusal and that `console.log` is never called).

## Medium

- **M1, rate limiter key. Fixed:** `BUIRY_TRUSTED_PROXY_HOPS` (default 0: the socket address, the header is ignored; 1 behind the ALB: the entry the ALB appended). Tests in `http.test.ts` show spoofed headers share one bucket. Original finding: `packages/api/src/http/app.ts:79` keys auth and public limits on the first `X-Forwarded-For` entry, which the client controls; without a proxy every caller shares the `local` bucket. Effect: an attacker sidesteps the per-address limit on sign-in link requests (each email is still capped at 5 links an hour) and can exhaust the shared bucket for others. Fix: take the address from the socket, and the right-most entry added by a configured number of trusted proxies (`BUIRY_TRUSTED_PROXIES`); behind an AWS ALB that is one hop.
- **M2, webhook SSRF. Fixed:** delivery resolves and checks once, then connects to exactly the checked address through a pinned lookup (no second resolution; TLS still verifies the host name). 198.18.0.0/15, 192.0.0.0/24, 64:ff9b::/96, 2002::/16 and IPv4-mapped IPv6 are refused. Tests in `webhook-rebinding.test.ts`, including a resolver that changes its answer and a real receiver behind an unresolvable host name. Original finding: `packages/api/src/service/events.ts` resolves the host and refuses private and internal addresses, and re-checks at send time (`packages/api/src/service/webhooks.ts`), but `fetch` then resolves the host again on its own (DNS rebinding window), and 198.18.0.0/15, 64:ff9b::/96 and 2002::/16 are not in the list. Needs a project admin to register the webhook. Fix: pin the checked address for the connection (custom `lookup` on the agent) and add the ranges.
- **M3, SSE streams. Fixed:** at most `BUIRY_SSE_MAX_PER_USER` (default 5) and `BUIRY_SSE_MAX_PER_PROJECT` (default 50) open streams per API process (one over the cap gets 429), and every 15 s a stream re-checks the caller's session and project access; on failure it sends an `end` event and closes. Tests in `sse-limits.test.ts`. Caps are per process, so the total across N API tasks is N times the cap. Original finding: `packages/api/src/http/routes-project.ts:402`: no per-user or global cap on open event streams, and a stream opened with a session keeps running after that session is revoked. Fix: a per-user cap, and re-check the session on each heartbeat.
- **M4, token lifetime. Fixed for new tokens:** agent tokens expire after `BUIRY_AGENT_TOKEN_MAX_DAYS` (server default 90, 0 = none) and are refused once expired; the Agents page shows each expiry and a reminder 14 days ahead; rotation revokes the old token at once (BD40). Tokens issued before this change keep no expiry until rotated. API tokens: unchanged, optional expiry with no default. Tests in `agent-token-expiry.test.ts`. Original finding: Agent tokens have no expiry; revocation is the only control. API tokens take an optional `expiresInDays` (`packages/api/src/service/dashboard.ts`) but default to none. Both tables record `last_used_at`. Fix: an expiry for agent tokens and a default expiry for API tokens, shown in the dashboard.
- **M5, unlogged 500s. Fixed:** one JSON log line per unexpected error with the request id, method, route pattern, error class, Postgres code and stack frames, and never the error message (database errors can quote memory text). Client request ids are kept only if plain. The MCP endpoint no longer echoes unexpected error messages to clients (found while fixing this). Tests in `server-errors.test.ts`. Original finding: `app.onError` returns a generic 500 with the request id but does not log the error, so incidents leave no trace. Fix: log the error with the request id (message and stack, never request bodies).
- **M6, in-memory database in production.** `packages/api/src/server.ts:66` only warns when `DATABASE_URL` is missing. A production start would accept writes and lose them on restart. Fixed in Phase 11: the production startup check refuses to start without `DATABASE_URL` (tested).
- **M7, pack import size. Fixed:** preview and import refuse more than `BUIRY_PACK_MAX_ITEMS` items (default 500) before any per-item work, items longer than the memory text limit (4000 characters by default) and items with more than 20 evidence entries; the 2 MiB body cap still applies. Preview used to stop silently at 2000 items while import continued. Tests in `pack-limits.test.ts`. Original finding: `packages/api/src/service/dashboard.ts` `importPack` has no item count limit beyond the 2 MiB body cap; a project writer could still import thousands of small memories in one call, each queued for storage. Fix: an item cap per import (and per plan).

## Low

- **L1, MCP sessions. Fixed:** sessions idle for 30 minutes are closed (checked on every request and on a timer); a later request with the old session id gets 404 and the client re-initializes. Test in `mcp-idle.test.ts`. Original finding: `createMcpHandler` keeps sessions in a map until the client closes them; abandoned sessions stay in memory. Fix: idle expiry.
- **L2, static containment.** Fixed with H1 (`startsWith(root)` would also have matched a sibling directory with the same prefix; the leading `..` stripping made it unreachable in practice).

## Reviewed and found sound

- Session cookies: HttpOnly, SameSite=Lax, Secure on https, plus an Origin check on state-changing requests.
- Tokens: stored as keyed hashes (HMAC with `BUIRY_SECRET_KEY`), shown once.
- Email sign-in: 24 random bytes, single use, 15 minutes, 5 per address per hour.
- OAuth: random 16-byte state, bound to the provider, single use, 10 minutes; fixed redirect URI built from `BUIRY_BASE_URL`.
- SQL: parameterised; the few interpolated identifiers come from whitelists.
- Webhook secrets: sealed with AES-256-GCM under a key derived from `BUIRY_SECRET_KEY`.
- Unexpected errors: the response says only "internal error" and the request id.
- Memory text reaching agents: MCP results that carry memory content are marked untrusted (notice in the text, `untrustedData` in structured content), and the server instructions say so.
- Packs: checksum, redaction, injection scan, imported as `proposed`.
- Showcase pages: opt-in per project.
- Dashboard: no `dangerouslySetInnerHTML`, `eval` or `innerHTML`; links are built from internal ids.

## Bring-your-own Walrus accounts (added after the review, Phase 5)

- Delegate keys: sealed with AES-256-GCM under a key derived from `BUIRY_SECRET_KEY` (own label), never returned by the API (only the public key), never logged (tested: API, activity log, console output, dashboard page). Decrypted keys live only inside cached adapters in process memory.
- Relayer URLs are user-supplied, so they go through the same destination check as webhooks (https, no private or internal addresses; development override refused in production). The DNS rebinding window of M2 applies here too and is fixed the same way.
- Only admins and owners can connect, rotate or disconnect; row-level security hides another workspace's rows (tested).
- Open: `BUIRY_SECRET_KEY` rotation needs a re-seal procedure (Phase 11, key custody).

## Found after the review (Phases 5 to 12)

- **Fixed (Phase 9):** the isolation canary planted memories through the normal write path. It claimed the single-tenant managed account on a fresh deployment, which locked out the first real workspace, and it queued a real Walrus write every hour. Internal workspaces now never write to Walrus. Tested.
- **Fixed (Phase 9):** the server closed idle connections after 5 s, shorter than load balancer idle timeouts, so connections were reset (ECONNRESET). It now keeps them for 65 s.
- **Fixed (Phase 11):** production now refuses to start with weak or missing settings, development switches left on, or pending migrations (`config-check.ts`). This also covers M6 (no in-memory database in production).
- **Dev-only advisory, accepted:** picomatch 4.0.7 ReDoS (GHSA-fc5q-39xc-vjpf), reachable only through build tooling (tsup, tinyglobby) with our own glob patterns. No fixed release exists; revisit when one does.

## Still open after Phase A (2026-11-17)

- **Per-process limits.** The auth and public rate limits, the SSE stream caps and MCP sessions are held in each API process's memory, so N API tasks allow N times each limit, and a restart resets them. Acceptable for the prototype; a shared store (Postgres or Redis) would make them global.
- **API tokens** still have no default expiry (optional per token); agent tokens issued before M4 keep no expiry until rotated.
- **Content Security Policy:** fixed in Phase 2.3 (see "Security headers" below).
- **Least-privilege database user** for the app (the deployment uses the RDS master user; see DEPLOYMENT).
- **Dev-only advisories** (picomatch, minimatch) as above, no fixed releases in range.

## M8: an agent can auto-promote its own memory (found 2026-11-18, open)

- **Severity: medium.** It needs a precondition (a valid agent token for the project). It defeats the anti-gaming rule that only other sessions' reports promote a memory (BD9), so an agent's unreviewed memory can become `confirmed` and be weighted as trusted in later briefings.
- **Code.**
  - `packages/core/src/learning.ts:255`-`:257`: a helpful report counts toward promotion unless it comes from the creating agent **and** the creating session.
  - `packages/api/src/service/auth.ts:88`: the session id is the client-supplied `x-buiry-session` header, or a fresh id for every request when the header is absent.
  - Promotion needs 3 counted reports from 2 distinct sessions (`learning.ts:52`), with at most 2 helpful reports per memory per day (`learning.ts:34`).
- **Covering tests.** `packages/core/test/learning.test.ts:113` covers only the same agent in the same session. No test covers the same agent in a new session.
- **Probe (throwaway test, not committed, PGlite, 2026-11-18).** One agent token wrote a memory, then reported it helpful twice on day 0 and once on day 1, with no session header. Result: `proposed` 0.376, then 0.401, then `confirmed` 0.8, "auto-promoted after repeated successful reuse".
- **Not fixed** (Phase 4 is docs only). A fix would count a report only from a different agent identity, or from a person.

## Finding count (Phase 4.3, 2026-11-18)

- **Review findings** (the summary table): 12, namely 3 high (H1–H3), 7 medium (M1–M7) and 2 low (L1, L2), with no critical. Of these:
  - 10 are fixed with a regression test;
  - M4 is fixed for new agent tokens only (API tokens still have no default expiry);
  - L2 is fixed without its own regression test: `packages/api/test/static.test.ts` tests a `..` escape, not a sibling directory with the same prefix.
- **Found later:**
  - three items fixed after the review ("Found after the review");
  - M8 above (open);
  - error-text sweep A1–A13, of which A1 and A6 are fixed;
  - fallback sweep B1–B8, of which B1 and B2 are fixed for production.

  The sweep items have no severity assigned yet.

- **Wording.** The line "12 findings (3 high, 7 medium, 2 low), all fixed with regression tests" was wrong about "all fixed with regression tests". It is corrected in `docs/design/01` and `03` and in `docs/ARCHITECT_BRIEFING.md`.

## Security headers (Phase 2.3, 2026-11-18)

Every response from the single HTTP listener now carries the headers below (`packages/api/src/http/security-headers.ts`, set in `startHttp`). That covers REST, MCP, the dashboard's static files and the SPA fallback, and error answers.

| Header                      | Value                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                            |
| `Referrer-Policy`           | `no-referrer`                                                                                                                                                                                        |
| `X-Frame-Options`           | `DENY`                                                                                                                                                                                               |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `Strict-Transport-Security` | `max-age=31536000`, only when the request is https: a TLS socket, or the last `X-Forwarded-Proto` value behind a trusted proxy (`BUIRY_TRUSTED_PROXY_HOPS` ≥ 1).                                     |

- **No report collection.** There is no report-uri and no unauthenticated report route.
- **Fallback.** `BUIRY_CSP=report-only` sends the policy as Report-Only. Even then, framing stays refused by an enforced `frame-ancestors 'none'` and `X-Frame-Options`.
- **Test.** `packages/api/test/security-headers.test.ts` checks the headers on static files, the fallback, REST, MCP and error answers, and checks when HSTS is sent. It fails on the old code.

**How it was checked (mock data, development server).**

1. **Report-Only pass.** With `BUIRY_CSP=report-only`, `scripts/dashboard-shots.ts` ran across 94 screens; it now records `securitypolicyviolation` events. It found one violation, 78 times: `font-src` blocked a `data:` URL. Vite had inlined a font subset smaller than 4 KiB into the stylesheet.
2. **Fix.** `apps/dashboard/vite.config.ts` now never inlines fonts.
3. **Report-Only re-run.** 0 violations on all 94 screens.
4. **Enforced pass.** All 94 screens rendered with no console errors and no failed requests (screenshots in `.buiry-local/csp-shots/`, mock sample data). The policy is enforced.

**Not checked:**

- HSTS through the real AWS load balancer (L-AWS3; needs AWS).
- Browsers other than Chrome.
- The OAuth and wallet sign-in screens with real providers (L-A1).

## Not reviewed

- Dependencies beyond `pnpm audit` (no supply-chain review of transitive packages).
- The Walrus relayer, Seal and Tatum services themselves, and the trust placed in their responses beyond what the verifiers check.
- Key custody and secret rotation in a real deployment (Phase 11, `docs/KEY_CUSTODY.md`).
- The worker's job handlers in depth (only the webhook delivery path was read).
- Denial of service through expensive queries (briefing with large projects is measured in Phase 10).
- Browser-side behaviour beyond reading the React code and the Phase 2.3 screen pass under an enforced CSP.
- Bring-your-own Walrus credentials (Phase 5 adds them; they get their own review then).

## Sweeps after Phase A (2026-11-18, report only; nothing fixed)

Read-only sweeps of `main` at `b480535`. Each finding gives the file and line. Severity is not assigned; these are inputs for the next security pass.

### Sweep A: where an error message can reach a client, a log, an activity row, a webhook delivery or `write_jobs.last_error`

| #   | Where                                                                                                                | What flows                                                                                                                                                                                                                                                                                                                                                    | Reaches                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `packages/api/src/service/verification.ts:55` (called at `:410`)                                                     | Any error that is not a `ChainError` inside the chain-read `try` becomes `BuiryError('internal', <raw message>)`. That `try` includes an activity-log database write (`:390` to `:401`). `packages/api/src/http/app.ts:160` returns `BuiryError` messages unchanged and does not log them, so the M5 rule (generic message, logged without text) is bypassed. | The client (REST and the `buiry_chain_read` tool). Not logged.                                                                                                                                      |
| A2  | `packages/mcp/src/server.ts:28`                                                                                      | `toolError` wraps any non-`BuiryError` as `internal: <raw message>`.                                                                                                                                                                                                                                                                                          | The agent. Over HTTP most errors arrive as API envelopes first, so this is mostly local exceptions (for example a failed fetch).                                                                    |
| A3  | `packages/storage/src/write-worker.ts:73`, `:75`, `:77`, `:82`, `:141`, `:148`                                       | Relayer-supplied error text (`json.error` or `json.message`, `packages/storage/src/http-adapter.ts:196` to `:200`; Seal session text scrubbed at `:347` to `:352`) and raw messages of other exceptions.                                                                                                                                                      | `write_jobs.last_error`, shown to project members in the dead-jobs list (`packages/api/src/service/dashboard.ts:666` to `:667`). Whether relayer error text can echo request content is UNVERIFIED. |
| A4  | `packages/api/src/service/webhooks.ts:325`, `:340`                                                                   | Raw exception messages from delivery (socket, TLS, timeouts).                                                                                                                                                                                                                                                                                                 | `webhook_deliveries.last_error`, listed to admins (`webhooks.ts:133` to `:136`). Destination-check messages are fixed strings (`packages/api/src/service/events.ts:204` to `:222`).                 |
| A5  | `packages/api/src/service/renewal.ts:85`                                                                             | Raw message of a failed renewal queue step, database errors included.                                                                                                                                                                                                                                                                                         | The renew API response, shown in a dashboard toast (`apps/dashboard/src/pages/StoragePage.tsx:47`).                                                                                                 |
| A6  | `packages/worker/src/scheduler.ts:53`, printed at `packages/worker/src/main.ts:79`                                   | Raw message of any failed job.                                                                                                                                                                                                                                                                                                                                | Process logs (CloudWatch in the AWS design). Database errors can quote row values, which is why M5 avoids messages; jobs are not covered by M5.                                                     |
| A7  | `packages/chain/src/tatum/grpc.ts:47`, then `verification.ts:51`; `packages/chain/src/verifiers.ts:80`, `:83`, `:86` | Tatum's gRPC `details` text, and raw verifier exception messages.                                                                                                                                                                                                                                                                                             | The client (`verification_unavailable`, text `chain gateway: ...`) and stored verification results shown in the dashboard.                                                                          |
| A8  | `packages/api/src/service/memory-service.ts:217`                                                                     | Code and message of failed agent operations, `BuiryError` only (`:207`).                                                                                                                                                                                                                                                                                      | Activity rows. Raw text gets here only through a path like A1.                                                                                                                                      |
| A9  | `packages/worker/src/migrate.ts:19`                                                                                  | Raw migration failure message.                                                                                                                                                                                                                                                                                                                                | Process logs. DDL only; low exposure.                                                                                                                                                               |

Checked and not a finding:

- `packages/api/src/service/byo-storage.ts:250` and `:260`: fixed messages, from `packages/api/src/service/walrus.ts:42` to `:47` and `events.ts`.
- `packages/storage/src/seal-session.ts:132` to `:135`: the message is scrubbed and carries no cause.
- `packages/worker/src/rotate-key.ts:31` and `:35`: table and id, or the error name only.
- `packages/api/src/server.ts:38`: the console mailer, development only (H3).

### Sweep A re-run after Phase 2.1

**Fixed in Phase 2.1:**

- **A1.** `mapChainError` (`packages/api/src/service/verification.ts:46`) now rethrows any non-chain error unchanged. The HTTP error handler answers with code `internal` and the message "internal error", and logs one M5 line: request id, route pattern, error class and Postgres code, with no message. Test: `packages/api/test/verification-errors.test.ts`; it fails on the old code with the raw message in the response.
- **A6.** Failed jobs are recorded and logged as `{"error":<class>,"code":<SQLSTATE>}` (`describeJobError` in `packages/worker/src/scheduler.ts`). The log line keeps the form `[buiry] job <name> failed: ...`, which the job-failures alarm matches. Test: "records and logs a failed job by error class and Postgres code, never the message" in `packages/worker/test/jobs.test.ts`.

**Still open, unchanged:** A2 to A5 and A7 to A9, at the same lines (the chain-read fix moved `verification.ts` lines by 3).

**Found by the re-run (not in the first sweep):**

| #   | Where                                      | What flows                                                         | Reaches                                                                                                                                             |
| --- | ------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A10 | `packages/worker/src/canary.ts:81`         | Raw message of an unexpected error during an isolation probe       | The canary's violation list, which goes to the audit log as `canary.violation` and to job results                                                   |
| A11 | `packages/api/src/service/networks.ts:35`  | Raw message when the relayer's `/config` cannot be read at startup | Process logs. A network error; low exposure                                                                                                         |
| A12 | `packages/storage/src/http-adapter.ts:181` | `relayer unreachable: <network error message>`                     | Feeds A3 (`write_jobs.last_error`). A network error; low exposure                                                                                   |
| A13 | `packages/worker/src/bin.ts:6`             | Raw message of a startup failure                                   | Process logs. Mostly config-check text, which is meant to be read. Whether a database connection error can include connection details is UNVERIFIED |

Client-side only, so not a server leak:

- `packages/mcp/src/rest-backend.ts:96`, network error text shown to the local agent;
- `packages/chain/src/tatum/evm.ts:29` and `jsonrpc.ts:69`, network errors wrapped into `ChainError`, which then flows as A7.

### Sweep A, Phase 5.4: triggered, rated and fixed (2026-11-18)

Each item was triggered in a test against the old code, and the text recorded below is what actually appeared. Severities use this review's scale. All are **low**: each needs a valid account or operator access, and none exposed a credential in the tests. Fixed with a stable code and a short message, logging the error class and Postgres code only (M5 format). Tests: `packages/api/test/error-text.test.ts`, `packages/chain/test/error-text.test.ts`, `packages/worker/test/startup-errors.test.ts`. All 8 failed on the old code.

| ID  | Text seen on the old code (test input marked)                                                                                                                                                                                | Who saw it                                                                                                                                                             | Severity and reason                                                                        | Now                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2  | `internal: duplicate key value (text)=(<stored value>)` from a database error during a tool call                                                                                                                             | the agent (MCP)                                                                                                                                                        | low: an authenticated agent, and row-level security limits stored values to its own tenant | `internal: internal error`; log `{"event":"tool_error","error":<class>,"code":<code>}`                                                           |
| A3  | `client: <relayer's own error text>`, for example a key or an internal URL if the relayer echoes them                                                                                                                        | project members (Storage page)                                                                                                                                         | low: members only; whether the real relayer echoes such text is unverified                 | `<kind>: <fixed message> (HTTP <status>)`, for example `client: the storage relayer rejected the request (HTTP 400)`                             |
| A12 | `relayer unreachable: fetch failed` (no host seen in the test)                                                                                                                                                               | feeds A3                                                                                                                                                               | low: no host or address appeared                                                           | `relayer unreachable` plus the cause code only; stored as `unavailable: the storage relayer was unreachable or unavailable`                      |
| A4  | `connect ECONNREFUSED 10.9.8.7:443 ...` (the resolved address and any exception text)                                                                                                                                        | workspace admins (delivery log)                                                                                                                                        | low: admins only, and the address belongs to their own endpoint                            | stable code from the error code, for example `connection_refused: the endpoint refused the connection`                                           |
| A5  | `duplicate key value (text)=(<stored value>)` as a renewal reason                                                                                                                                                            | nobody: `rewriteRenewer` keeps only the ids, and the dashboard renew path returns only Buiry's own reasons (the first sweep's claim that it reached a toast was wrong) | low: no exposure found                                                                     | `internal error`; log `renewal_error` with class and code                                                                                        |
| A7  | `<gateway details text>` in `ChainError` messages; `verification error: <exception text>` in stored results                                                                                                                  | clients (`verification_unavailable`) and stored verification results                                                                                                   | low: text comes from the gateway or local exceptions; no secret seen                       | `gateway returned <gRPC status name>`; `network error`; `unexpected gateway error`; `verification error`                                         |
| A10 | `<label>: unexpected error <exception text>`                                                                                                                                                                                 | the audit log (`canary.violation`)                                                                                                                                     | low: operators only                                                                        | `<label>: unexpected error {"error":<class>,"code":<code>}`; no separate test (the canary's error path needs a non-Buiry failure inside a probe) |
| A13 | `[buiry] failed to start: password authentication failed for user "<user>"`; `getaddrinfo ENOTFOUND <host>`; `connect ECONNREFUSED <ip>:<port>` (bad URLs against the throwaway Postgres 16.15; the password never appeared) | process logs                                                                                                                                                           | low: operators only, but it names the database user, host and port                         | `[buiry] failed to start: {"error":"Error","code":"ECONNREFUSED"}`; Buiry's own `[buiry] ...` startup refusals are unchanged                     |

**Recorded, not changed:** A8, A9 and A11.

- **Unchanged line.** The `[buiry] job <name> failed` line the alarm matches is unchanged (Phase 2.1).
- **Updated test.** `packages/mcp/test/mcp.test.ts` used to expect the raw message `boom`; it now expects `internal error` and the logged class.

### Sweep B: modes or settings that can silently fall back to a shared or default resource

| #   | Where                                                                           | Fallback                                                                                                                                                           | Guarded in production?                                                                                                          |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `packages/api/src/server.ts:131`; `packages/api/src/service/byo-storage.ts:207` | Without `BUIRY_MANAGED_WORKSPACE_ID`, the first workspace to create a managed project claims the shared account (BD41).                                            | No. `packages/api/src/config-check.ts:38` to `:49` does not require it.                                                         |
| B2  | `packages/api/src/server.ts:130`                                                | `BUIRY_MANAGED_MULTI_TENANT=1` lets every workspace share the managed account, so one Seal session reaches every tenant (A26).                                     | No. config-check neither refuses nor warns.                                                                                     |
| B3  | `packages/api/src/service/byo-storage.ts:206`                                   | With no tenancy setting on the storage registry, every workspace may use the managed account.                                                                      | `server.ts:126` to `:133` always sets tenancy, so only embedders and tests reach this path.                                     |
| B4  | `packages/api/src/service/byo-storage.ts:99`                                    | The comment says "unset means the first workspace to write claims it". Since BD41 the claim happens at managed project creation. A stale comment, not a behaviour. | n/a                                                                                                                             |
| B5  | `packages/api/src/server.ts:186`                                                | `BUIRY_TRUSTED_PROXY_HOPS` defaults to 0. Behind a proxy without it, every client shares the proxy's rate-limit bucket.                                            | The Terraform task definition sets 1. Other deployments are not guarded.                                                        |
| B6  | `packages/chain/src/tatum.ts:596`                                               | `TATUM_NETWORK` defaults to mainnet when a gateway is configured.                                                                                                  | Yes, indirectly: `packages/api/src/service/networks.ts:27` to `:28` applies the same default and refuses mixed networks (BD33). |
| B7  | `packages/api/src/server.ts:54`, `:83`, `:90`, `:161`                           | Console mailer, in-memory database, random development secret key, localhost base URL.                                                                             | Yes: config-check refuses each in production (`config-check.ts:16`, `:19`, `:30`, `:61`).                                       |
| B8  | Learning settings (BD27)                                                        | Invalid per-project values are ignored, and the service defaults apply.                                                                                            | The Settings page banner says so; it is not an error.                                                                           |

**Phase 2.2 update.** B1 and B2 are fixed for production (BD42): the startup check requires `BUIRY_MANAGED_WORKSPACE_ID` or `BUIRY_MANAGED=off`, and refuses `BUIRY_MANAGED_MULTI_TENANT=1`. Tests are in `packages/api/test/production.test.ts`. Development keeps the first-creator claim.

**Can config-check require `BUIRY_MANAGED_WORKSPACE_ID` or an explicit managed-off in production?** Yes, with a small change.

- **Requiring the workspace id.** `checkProductionConfig` is a pure check over the environment. Inside the block that runs when all three `WALRUS_*` settings are present (`config-check.ts:42`), it could require `BUIRY_MANAGED_WORKSPACE_ID` unless `BUIRY_MANAGED_MULTI_TENANT=1` is set deliberately.
  - It can check the id's format.
  - It cannot check that the workspace exists; that needs the database after migrations.
- **Managed-off.** Today it is implicit: leave all three `WALRUS_*` settings unset. An explicit switch would be a new setting name. It is not built.
