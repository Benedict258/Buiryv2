# Security review

Scope: the code on `main` as of commit `83b58e9` (API server, MCP HTTP transport, auth, webhooks, packs, dashboard static serving, dashboard React code). Method: reading the code and running targeted tests. This is an internal review, not a penetration test or an external audit.

Severity: **critical** = remote compromise or cross-tenant data access without credentials; **high** = an unauthenticated attacker can take the service down or obtain a credential; **medium** = needs a precondition (a deployment choice, a valid account, a network position) or limits damage poorly; **low** = hardening.

## Summary

| ID  | Severity | Finding                                                                    | Status                                             |
| --- | -------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| H1  | high     | Malformed URL escape threw inside the raw request listener                 | Fixed in `83b58e9`, regression test                |
| H2  | high     | No request body size limit (REST and MCP), unauthenticated routes included | Fixed in `83b58e9`, regression tests               |
| H3  | high     | Sign-in links (bearer secrets) printed to logs when no mailer is set       | Fixed in `83b58e9` for production, regression test |
| M1  | medium   | Rate limiter keys on the first `X-Forwarded-For` entry                     | Open                                               |
| M2  | medium   | Webhook destination check: DNS rebinding window, missing reserved ranges   | Open                                               |
| M3  | medium   | No cap on concurrent SSE streams; streams outlive a revoked session        | Open                                               |
| M4  | medium   | Agent tokens never expire; API token expiry is optional and off by default | Open                                               |
| M5  | medium   | Unexpected (500) errors are not logged                                     | Open                                               |
| M6  | medium   | Production can start on an in-memory database                              | Open (Phase 11 startup check)                      |
| M7  | medium   | No item count cap on pack import (only the 2 MiB body cap from H2)         | Open                                               |
| L1  | low      | MCP sessions live in process memory with no idle expiry                    | Open                                               |
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
- **Fix:** `mailerFromEnv` never returns the console mailer when `NODE_ENV=production`; production without a configured mailer refuses email sign-in with a clear error and logs nothing. Development still prints links. A real mailer is Phase 7.
- **Test:** `static.test.ts`, "never uses the console mailer in production" (asserts the mailer type, the refusal and that `console.log` is never called).

## Medium

- **M1, rate limiter key.** `packages/api/src/http/app.ts:79` keys auth and public limits on the first `X-Forwarded-For` entry, which the client controls; without a proxy every caller shares the `local` bucket. Effect: an attacker sidesteps the per-address limit on sign-in link requests (each email is still capped at 5 links an hour) and can exhaust the shared bucket for others. Fix: take the address from the socket, and the right-most entry added by a configured number of trusted proxies (`BUIRY_TRUSTED_PROXIES`); behind an AWS ALB that is one hop.
- **M2, webhook SSRF.** `packages/api/src/service/events.ts` resolves the host and refuses private and internal addresses, and re-checks at send time (`packages/api/src/service/webhooks.ts`), but `fetch` then resolves the host again on its own (DNS rebinding window), and 198.18.0.0/15, 64:ff9b::/96 and 2002::/16 are not in the list. Needs a project admin to register the webhook. Fix: pin the checked address for the connection (custom `lookup` on the agent) and add the ranges.
- **M3, SSE streams.** `packages/api/src/http/routes-project.ts:402`: no per-user or global cap on open event streams, and a stream opened with a session keeps running after that session is revoked. Fix: a per-user cap, and re-check the session on each heartbeat.
- **M4, token lifetime.** Agent tokens have no expiry; revocation is the only control. API tokens take an optional `expiresInDays` (`packages/api/src/service/dashboard.ts`) but default to none. Both tables record `last_used_at`. Fix: an expiry for agent tokens and a default expiry for API tokens, shown in the dashboard.
- **M5, unlogged 500s.** `app.onError` returns a generic 500 with the request id but does not log the error, so incidents leave no trace. Fix: log the error with the request id (message and stack, never request bodies).
- **M6, in-memory database in production.** `packages/api/src/server.ts:66` only warns when `DATABASE_URL` is missing. A production start would accept writes and lose them on restart. Fix: the production startup check in Phase 11 refuses to start.
- **M7, pack import size.** `packages/api/src/service/dashboard.ts` `importPack` has no item count limit beyond the 2 MiB body cap; a project writer could still import thousands of small memories in one call, each queued for storage. Fix: an item cap per import (and per plan).

## Low

- **L1, MCP sessions.** `createMcpHandler` keeps sessions in a map until the client closes them; abandoned sessions stay in memory. Fix: idle expiry.
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

## Not reviewed

- Dependencies beyond `pnpm audit` (no supply-chain review of transitive packages).
- The Walrus relayer, Seal and Tatum services themselves, and the trust placed in their responses beyond what the verifiers check.
- Key custody and secret rotation in a real deployment (Phase 11, `docs/KEY_CUSTODY.md`).
- The worker's job handlers in depth (only the webhook delivery path was read).
- Denial of service through expensive queries (briefing with large projects is measured in Phase 10).
- Browser-side behaviour beyond reading the React code (no CSP is set yet; worth adding with the AWS deployment).
- Bring-your-own Walrus credentials (Phase 5 adds them; they get their own review then).
