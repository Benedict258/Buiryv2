# 02. Dashboard and design system (sections 5 and 6)

Part of the design report (`00-index.md`). Evidence levels are defined in `01-product-and-proof.md`.

## 5. The dashboard as it exists today

**Source.** Routes are in `apps/dashboard/src/App.tsx`, pages in `apps/dashboard/src/pages/`, and the shell and command palette in `apps/dashboard/src/components/`.

**How it talks to the server.** The dashboard uses only the public REST API (`/v1`). Sessions are an HttpOnly cookie (BD24). Live updates come from the activity SSE stream, read with `fetch` (BD25).

**Screenshots.** `scripts/dashboard-shots.ts` captured 94 screenshots into `.buiry-local/design-shots/` (gitignored), run against the development server (`pnpm dev:api`, HANDOFF section 6):

| Pass  | Screenshots |
| ----- | ----------- |
| dark  | 32          |
| light | 32          |
| phone | 30          |

The script fails on console errors and failed API requests, and none occurred. These screenshots are **MOCK SAMPLE DATA** (BD28): a seeded sample project ("Northwind Labs / orbit-api") on MockRelayer, MockTatum and PGlite. They show layout only. Never present them as proof. The sample data declares `sui:mainnet` on a testnet-first product, which would mislead if shown publicly.

### Screen inventory

**Common to every screen.**

- **States.** "States" lists what the page handles in code. Loading is a skeleton and errors are an error block with a retry, both through `Async` in `components/ui.tsx`. "Degraded" means the page renders a specific degraded or unknown state.
- **Roles.** Gating uses `can(role, ...)`. Readers see read-only views.
- **Phone layout.** Below 767 px (`app.css:993`) the sidebar is replaced by a bottom bar: Overview, Memory, Alerts, Activity, More.

| Route                                                                 | Purpose                          | Data shown                                                                       | Actions                                                                                  | States handled                                           | Role gating                                                                                                                                                                                  | Mobile notes                                            |
| --------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `/signin`                                                             | Sign in                          | Methods: email link, pasted session token, Sui wallet, GitHub and Google buttons | Continue with email, GitHub, Google or a Sui wallet; paste a session token               | sent, error                                              | public                                                                                                                                                                                       | single card                                             |
| `/auth/email`                                                         | Email-link landing               | none (redirects to `/signin` with the token)                                     | none                                                                                     | n/a                                                      | public                                                                                                                                                                                       | n/a                                                     |
| `/onboarding`                                                         | Five-step wizard                 | Workspace name, project, networks, storage choice, install, connect, first event | Name workspace (reuses the personal one), create project, copy commands, test connection | loading, error, storage policy banner, waiting-for-event | signed in; workspace reuse only for owners                                                                                                                                                   | full width card                                         |
| `/invite/:token`                                                      | Accept an invitation             | Workspace and role                                                               | Accept                                                                                   | error (used or expired link, HTTP 404)                   | signed in                                                                                                                                                                                    | single card                                             |
| `/showcase/:pid`                                                      | Public read-only project page    | Confirmed memories and chosen sections                                           | none                                                                                     | loading, not found                                       | public                                                                                                                                                                                       | stacked                                                 |
| `/w/:ws/projects`                                                     | Project list                     | Projects, counts, networks                                                       | New project, filter                                                                      | loading, error, empty, no matches                        | create: admin                                                                                                                                                                                | list                                                    |
| `/w/:ws/team`                                                         | Members and invitations          | Names, emails, roles, open invitations                                           | Invite (link shown once), revoke an invitation, remove a member                          | loading, error, empty                                    | invite and manage: admin; writers do not request invitations                                                                                                                                 | table                                                   |
| `/w/:ws/integrations`                                                 | Webhooks (Slack, Discord, HTTPS) | Endpoints, deliveries                                                            | Add, test, replay a delivery, delete                                                     | loading, error, empty                                    | admin                                                                                                                                                                                        | table                                                   |
| `/w/:ws/api`                                                          | API tokens                       | Tokens (hash only), expiry                                                       | Create (shown once), revoke                                                              | loading, error, empty                                    | admin                                                                                                                                                                                        | table                                                   |
| `/w/:ws/billing`                                                      | Plan and usage                   | Plan, usage bars, invoices                                                       | Compare plans                                                                            | loading, error; placeholders                             | admin or owner: the API refuses others (`assertManage`, `packages/api/src/service/dashboard.ts:990`; reader gets 403 in `packages/api/test/rest.test.ts:175`); the page itself does not gate | stacked                                                 |
| `/w/:ws/account`                                                      | Account                          | Name, email, user id, linked identities, theme                                   | Sign out everywhere, switch theme                                                        | loading, error                                           | self                                                                                                                                                                                         | stacked                                                 |
| `/w/:ws/notifications`                                                | Notification centre              | Recent alerts across projects                                                    | Open the related page (links)                                                            | loading, error, empty                                    | member                                                                                                                                                                                       | list                                                    |
| `/w/:ws/p/:pid/overview`                                              | Project overview                 | Stat cards, needs attention, get started, storage banner                         | Open memory, view alerts, connect an agent                                               | loading, error, empty, needs-own-account banner          | admin actions gated                                                                                                                                                                          | "Needs attention" card overflows horizontally at 390 px |
| `.../memory`                                                          | Memory explorer and review queue | Table: status, type, text, confidence, agent, branch, evidence                   | Filter, search, export, new memory, bulk confirm or tombstone, open drawer               | loading, error, empty, no matches                        | writer: create; admin: confirm, tombstone                                                                                                                                                    | table becomes a list                                    |
| Memory drawer (Overview, Evidence, History, Lineage, Provenance tabs) | One memory in full               | Text (marked untrusted), evidence, events, lineage, write state                  | Confirm, contest, supersede, tombstone, re-verify, resolve conflict                      | saving to storage, failed write, degraded verify         | writer or admin by action                                                                                                                                                                    | full-screen drawer                                      |
| Memory editor (modal)                                                 | New or edit memory               | Type, text, evidence                                                             | Save                                                                                     | validation, redaction refusal                            | writer; admin for confirmed                                                                                                                                                                  | full-screen modal                                       |
| `.../timeline`                                                        | Timeline and replay              | Events by time; replay to a point                                                | Replay to a point (range control), filter                                                | loading, error, empty                                    | member                                                                                                                                                                                       | stacked                                                 |
| `.../branches`                                                        | Branches and merge               | Branches, diff, merge preview                                                    | New branch, merge (three steps)                                                          | loading, error, empty, nothing to merge                  | writer: create; admin: merge into main                                                                                                                                                       | stacked                                                 |
| `.../agents`                                                          | Agents                           | Agents, permissions, branch scope, token expiry, recent memories                 | Connect (token shown once), rotate, revoke                                               | loading, error, empty, expiry reminder banner            | admin                                                                                                                                                                                        | table                                                   |
| `.../activity`                                                        | Activity log                     | Operations, actor, result, latency                                               | Filter                                                                                   | loading, error, empty, no matches, live flash            | member                                                                                                                                                                                       | list                                                    |
| `.../alerts`                                                          | Alerts and flags                 | Flags (stale, conflict, expiry), rules                                           | Acknowledge, resolve, new rule                                                           | loading, error, empty, degraded                          | writer: resolve; admin: rules                                                                                                                                                                | list                                                    |
| `.../verification`                                                    | Chain verification               | Gateway status, latency, error rate, transport mix, usage, evidence list         | Verify a transaction, connectivity test, re-verify                                       | loading, error, empty, unknown or degraded               | writer: re-verify                                                                                                                                                                            | cards stack                                             |
| `.../handoffs`                                                        | Handoffs                         | Session handoffs                                                                 | read only                                                                                | loading, error, empty                                    | member                                                                                                                                                                                       | list                                                    |
| `.../briefing`                                                        | Briefing preview                 | Briefing text, budget, per-item score and "why" (BD29)                           | Preview for a task, set the token budget                                                 | loading, error, empty                                    | member                                                                                                                                                                                       | stacked                                                 |
| `.../packs`                                                           | Export and import                | Packs, preview with checks                                                       | Export, import (preview first)                                                           | loading, error, empty, refused file                      | writer                                                                                                                                                                                       | stacked                                                 |
| `.../storage`                                                         | Storage health and own account   | Blob ids, expiry, write queue, dead jobs, renewal, own-account form              | Renew selected; connect, rotate or disconnect an own account                             | loading, error, empty, renewal off, degraded             | writer: renew; admin: account                                                                                                                                                                | stacked                                                 |
| `.../settings`                                                        | Project settings                 | Name, networks, learning rules, token budget, showcase, BUIRY.md                 | Save, enable the showcase, archive the project                                           | loading, error, read-only banner                         | admin                                                                                                                                                                                        | stacked                                                 |
| Command palette (Ctrl K)                                              | Jump to anything                 | Memories, agents, pages                                                          | Search, navigate                                                                         | empty                                                    | member                                                                                                                                                                                       | search button                                           |
| `*`                                                                   | 404                              | "Nothing buried here"                                                            | Go home                                                                                  | n/a                                                      | public                                                                                                                                                                                       | single card                                             |

There is no route for the marketing site, a 500 page, the internal admin console, legal pages or docs. "Docs" in the sidebar is a link only.

### Gap table against `docs/04-ui-spec.md`

| Spec item                                                                                                                                  | Status                        | Notes; placeholder wording users see (quoted from the code)                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 to 5.11 Marketing site (home, how it works, features, pricing, security, docs hub, changelog, showcase, open source, sign in, utility) | not built                     | Only sign-in, the public showcase and a 404 exist. No marketing routes.                                                                                                  |
| 6.1 Onboarding wizard                                                                                                                      | built, deliberately different | See "Deliberate contradictions" below.                                                                                                                                   |
| 6.2 Workspace switcher                                                                                                                     | built                         | In the sidebar header, with a plan chip ("free").                                                                                                                        |
| 6.3 Projects list, 6.4 Overview                                                                                                            | built                         | n/a                                                                                                                                                                      |
| 7.1 to 7.3 Explorer, drawer, editor                                                                                                        | built                         | Bulk actions are confirm and tombstone only. Bulk move-to-branch is absent, with no placeholder text (BD26 says each placeholder explains itself; this one does not).    |
| 7.4 Conflict resolution                                                                                                                    | partly built                  | "possible conflict" chip and resolve actions in the drawer; no side-by-side resolution screen.                                                                           |
| 7.5 Timeline and replay                                                                                                                    | built                         | Replay query exists (`Timeline.tsx:71`).                                                                                                                                 |
| 7.6 Branches                                                                                                                               | built                         | n/a                                                                                                                                                                      |
| 8.1 to 8.6 Agents, activity, alerts, verification, handoffs, briefing                                                                      | built                         | Flag notes are absent, with no placeholder text.                                                                                                                         |
| 9.1 Packs, 9.2 Storage, 9.3 Team, 9.4 Settings, 9.5 Integrations, 9.6 API tokens                                                           | built                         | Storage: "Renewal is turned off on this deployment (BUIRY_RENEWAL)" when off.                                                                                            |
| 9.7 Billing                                                                                                                                | placeholder                   | "Price: to be set"; "Prices are placeholders until they are set."; "No payment method. Card or Sui payments are not enabled yet."                                        |
| 9.8 Public showcase                                                                                                                        | built                         | "Public view. This page shows only what the project owner chose to share..."                                                                                             |
| 9.9 Account, 9.10 Notifications, 9.11 Command palette                                                                                      | built                         | n/a                                                                                                                                                                      |
| 9.12 Admin console (internal)                                                                                                              | not built                     | No route, no placeholder.                                                                                                                                                |
| Sign in: wallet                                                                                                                            | placeholder                   | "Connecting a wallet requires a browser wallet extension, which this build does not bundle."                                                                             |
| 10 State catalog                                                                                                                           | mostly built                  | Loading, error and empty states throughout. A 500 page does not exist; the app shows "We could not load your account" with a retry when `/v1/auth/me` fails (`App.tsx`). |
| 11 Responsive                                                                                                                              | built                         | Breakpoints at 1279 px and 767 px. Some tables and cards overflow at 390 px (see below).                                                                                 |

### Deliberate contradictions of `docs/04-ui-spec.md`

| Spec (6.1, step 2)                                    | Build                                                                                                                                                                                                                                | Record                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Managed is "(recommended)"                            | Managed serves one workspace. For any other workspace it is shown as "(not available here)", with a banner, and bring-your-own is preselected.                                                                                       | BD41                      |
| Bring your own account: "requires a connected wallet" | It needs a Walrus Memory account and a delegate key, connected on the project's Storage page after creation. Copy: "Your own Walrus Memory account: after creating the project, connect it on the Storage page with a delegate key." | BD36, BD41                |
| Self-hosted relayer: "Advanced"                       | Shown as "Not available yet." with "Running your own relayer is planned; choose one of the options above for now."; the API refuses it.                                                                                              | BD41                      |
| Step 1 creates a workspace                            | It names and reuses the personal workspace created at first sign-in.                                                                                                                                                                 | BD41                      |
| Networks: "Sui mainnet, Sui testnet, none"            | It starts from the deployment's network in `/v1/healthz`; a testnet deployment refuses `sui:mainnet`.                                                                                                                                | BD33, `docs/BEHAVIOUR.md` |

### Visually weak, inconsistent or confusing (from the screenshots; opinion unless stated)

| Screen                                         | Issue                                                                                                                                                                              | Why it matters                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Memory table at 1440 × 900 (`dark-memory.png`) | The Evidence column is cut off at the right edge; the table scrolls inside the page.                                                                                               | The proof column is the one hidden.                                                             |
| Sidebar at 900 px height                       | The "WORKSPACE" section heading is clipped behind the footer block.                                                                                                                | Looks broken on common laptop heights.                                                          |
| Overview at 390 px (`phone-overview.png`)      | "Needs attention" overflows horizontally.                                                                                                                                          | Horizontal scroll on phones.                                                                    |
| Verification (`light-verification.png`)        | "Usage by hour" with sparse data is one solid block. "LATENCY 133 / 133 ms" repeats the number with n=2.                                                                           | Weak data visual; percentiles over two calls mislead.                                           |
| Verification evidence list                     | File and test evidence show "Last verified: never" and a disabled re-verify, although they are never chain-checked by design.                                                      | Reads as a failure.                                                                             |
| Billing (`dark-billing.png`)                   | Seats at 1 of 1 is a full red bar with an error-coloured sentence.                                                                                                                 | Uses the stale/error colour for a normal state.                                                 |
| Memory rows on mocks                           | Many rows read "Saving to storage" in the sample data.                                                                                                                             | Makes the product look stuck in screenshots.                                                    |
| Copy commands across pages                     | `npx buiry ...` appears in Overview, Memory, Projects, Agents, Settings and Onboarding. The owner chose `npx @buiry/cli` (decision 16); the dashboard still shows the old command. | Blocked: packages are unpublished, and the npm name `buiry` is not a release name (section 13). |
| Inline styles                                  | 187 `style={{...}}` attributes across the pages (count from `grep`).                                                                                                               | Spacing and layout drift outside the tokens.                                                    |

### Controls whose effect changed in Phase 6.1 (dashboard not changed)

| Control                                          | Where                                                                                                                                                                      | Effect now                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Auto-promotion" setting (thresholds, on or off) | Project Settings (`apps/dashboard/src/pages/Settings.tsx:296`, label "Auto-promote memories that agents repeatedly report helpful", and the two threshold fields below it) | Reports never confirm (M8, BD44). The thresholds only mark a report "ready for a person to confirm".                                                                                                 |
| `confirm` permission when connecting an agent    | Agents (`apps/dashboard/src/pages/Agents.tsx:32`, shown again at `:132` and in the drawer at `:490`)                                                                       | No longer lets an agent confirm (supersedes BD11). Still offered as "Confirm: confirm other agents' memories (never its own)".                                                                       |
| API token scopes and expiry                      | API tokens (`apps/dashboard/src/pages/WorkspacePages.tsx:796`, table at `:718`, create at `:772`)                                                                          | The scope list offers read, write and admin, not the new `confirm` scope (Phase 7.4). The table has no expiry column. Creation sends no expiry, so every new token silently gets the 90-day default. |

### Accessibility: tested versus assumed

| Aspect                              | Status                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Colour contrast                     | Computed now for every token pair (section 6). Not checked in a browser tool.                                |
| Status not by colour alone          | Built: each status chip has an icon and a label (screenshots). Not tested with users.                        |
| Focus outline                       | A `:focus-visible` rule exists (`app.css:59`). Focus order not tested.                                       |
| Keyboard operation                  | Radio cards and the command palette have key handlers. No full keyboard pass was run. UNVERIFIED.            |
| Screen readers                      | 107 `aria-*` attributes in the code. Never tested with a screen reader. UNVERIFIED.                          |
| Reduced motion                      | `@media (prefers-reduced-motion: reduce)` disables animation and transitions in CSS. Not tested on a device. |
| Automated audit (axe or Lighthouse) | Not run.                                                                                                     |
| Skip link, landmarks                | No skip link found.                                                                                          |
| Language                            | `<html lang="en">` (`apps/dashboard/index.html`).                                                            |

## 6. The design system as it exists

### Where it lives

- **Tokens.** `apps/dashboard/src/styles/tokens.css` (63 lines): colour per theme, fonts, radii, spacing and one motion duration.
- **Styles.** `apps/dashboard/src/styles/app.css` (1078 lines).
- **Components.** `apps/dashboard/src/components/ui.tsx`, plus `Shell.tsx` and `CommandPalette.tsx`.
- **Icons and fonts.** Icons are `lucide-react`. Fonts are Inter Variable and JetBrains Mono Variable from fontsource, self-hosted in the bundle.
- **No separate package exists (BD23).**

### Tokens: what the spec proposed versus what the code uses

| Category          | Spec (`04-ui-spec.md` section 2, "proposals")                      | Code                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colour            | Neutrals, brand and eight statuses for dark and light              | Same values, except light `text-tertiary`: spec #6B7887, code #5F6C7B. Adds `--on-brand` and `--shadow-pop`.                                                                    |
| Type              | Inter scale 48/32/24/18/14/13/12, mono 13                          | Families as spec. Sizes are hard-coded px in `app.css` (11, 12, 13, 14, 18, 24, 28, 32). 11 px and 28 px are not in the spec; the 48 px display size is unused. No type tokens. |
| Spacing           | 4, 8, 12, 16, 24, 32, 48, 64                                       | `--sp-1` to `--sp-7` = 4 to 48; 64 is missing.                                                                                                                                  |
| Radius            | 6, 8, 12                                                           | `--r-sm/md/lg` = 6, 8, 12. Also hard-coded 2, 3, 4, 5, 10 and 12 px, and 50%.                                                                                                   |
| Elevation         | Flat; soft shadow on light popovers                                | `--shadow-pop`: none in dark, soft in light. Matches.                                                                                                                           |
| Motion            | 120 to 200 ms ease-out; live rows highlight 800 ms; reduced motion | `--t-fast` 140 ms. Animations: `flash 0.8s`, `pulse 1.4s`, `slide 160ms`, `spin 0.7s`. Reduced-motion rule present. Matches the spec's intent.                                  |
| Hard-coded colour | Spec: "components reference tokens, never raw values"              | `#fff` twice (`app.css:203` badge, `:392` danger button) and one overlay `rgba(0,0,0,0.45)` (`:684`). None in the TSX.                                                          |

### Dark and light coverage

- Both themes are defined for every colour token, and all 32 dark and 32 light screenshots exist.
- The default is dark (`index.html` `data-theme="dark"`, `lib/app.tsx:17`). The system preference (`prefers-color-scheme`) is ignored.

### Components in code

The components exported from `components/ui.tsx` fall into these groups:

- **Actions:** `Button`, `CopyButton`, `CodeBlock`, `IdBlock`.
- **Memory and status chips:** `StatusChip`, `TypeChip`, `ConfidenceMeter`, `EvidenceChip`, `AgentBadge`, `BranchPill`, `ExpiryIndicator`, `WriteState`.
- **Layout and content:** `PageHead`, `Card`, `Stat`, `Banner`, `Untrusted`.
- **States:** `Empty`, `Skeleton`, `ErrorBlock`, `Async`.
- **Forms and navigation:** `Field`, `Tabs`, `Segmented`.
- **Data visuals:** `Usage`, `Sparkline`, `StackBar`.
- **Overlays and feedback:** `Drawer`, `Modal`, `ConfirmModal`, `Popover`, `Toasts`, `TokenReveal`.
- **Small helpers:** `Chev`, `Help`.

The shell and command palette are separate components.

### Components missing for the marketing site

Inventory only; none is designed yet:

- **Page structure:** site header and footer, the legal page layout, and 404 and 500 pages styled for the site.
- **Home and landing blocks:** hero, feature grid, how-it-works step sequence, call-to-action band, FAQ accordion.
- **Proof and trust:** the architecture and trust-boundary diagram, a proof card (result, network, n, source link), and a network status pill (testnet or Mainnet).
- **Pricing and comparison:** the pricing table (if pricing is shown) and a comparison table (if comparisons are approved, section 12).
- **Docs and content:** the docs layout (sidebar, table of contents, code tabs), changelog entries, and the blog post layout.
- **Optional:** a cookie or consent banner, only if analytics is added.

### WCAG contrast: every text-on-background and status pair, both themes

**Method.** A throwaway script (`contrast.cjs`, kept outside the repo) parsed `tokens.css` and computed the WCAG 2.1 contrast ratio for each pair. Foregrounds: `text-primary`, `text-secondary`, `text-tertiary`, `brand` and the eight statuses. Backgrounds: `bg-canvas`, `bg-surface`, `bg-raised` and `brand-subtle`. It also checked `on-brand` on `brand`, the hard-coded `#fff` on `s-stale`, and the input border on the surface.

Thresholds: 4.5:1 for body text, 3:1 for large text and icons.

**Result.** 102 pairs:

- 31 are under 4.5:1;
- 3 are under 3:1.

**Pairs under 4.5:1 (body text fails), as printed by the script:**

```text
theme | foreground | background | fg | bg | ratio | verdict
dark | text-tertiary | bg-canvas | #6b7887 | #0b0f14 | 4.27 | large/icon only
dark | text-tertiary | bg-surface | #6b7887 | #11171e | 4.00 | large/icon only
dark | text-tertiary | bg-raised | #6b7887 | #18202a | 3.65 | large/icon only
dark | text-tertiary | brand-subtle | #6b7887 | #0f2b2a | 3.33 | large/icon only
dark | s-tombstoned | bg-canvas | #64748b | #0b0f14 | 4.04 | large/icon only
dark | s-tombstoned | bg-surface | #64748b | #11171e | 3.79 | large/icon only
dark | s-tombstoned | bg-raised | #64748b | #18202a | 3.45 | large/icon only
dark | s-tombstoned | brand-subtle | #64748b | #0f2b2a | 3.15 | large/icon only
dark | #fff (app.css .badge-n, .btn.danger.solid) | s-stale | #ffffff | #f87171 | 2.77 | FAIL
dark | border-default (input edge, non-text) | bg-surface | #2b3948 | #11171e | 1.53 | FAIL
light | brand | bg-canvas | #0d9488 | #f7f9fb | 3.55 | large/icon only
light | brand | bg-surface | #0d9488 | #ffffff | 3.74 | large/icon only
light | brand | bg-raised | #0d9488 | #f0f3f7 | 3.36 | large/icon only
light | brand | brand-subtle | #0d9488 | #e0f5f2 | 3.30 | large/icon only
light | s-confirmed | bg-canvas | #059669 | #f7f9fb | 3.57 | large/icon only
light | s-confirmed | bg-surface | #059669 | #ffffff | 3.77 | large/icon only
light | s-confirmed | bg-raised | #059669 | #f0f3f7 | 3.39 | large/icon only
light | s-confirmed | brand-subtle | #059669 | #e0f5f2 | 3.32 | large/icon only
light | s-contested | brand-subtle | #b45309 | #e0f5f2 | 4.43 | large/icon only
light | s-stale | bg-raised | #dc2626 | #f0f3f7 | 4.34 | large/icon only
light | s-stale | brand-subtle | #dc2626 | #e0f5f2 | 4.26 | large/icon only
light | s-superseded | bg-raised | #64748b | #f0f3f7 | 4.28 | large/icon only
light | s-superseded | brand-subtle | #64748b | #e0f5f2 | 4.20 | large/icon only
light | s-tombstoned | bg-raised | #64748b | #f0f3f7 | 4.28 | large/icon only
light | s-tombstoned | brand-subtle | #64748b | #e0f5f2 | 4.20 | large/icon only
light | s-verified | bg-canvas | #0d9488 | #f7f9fb | 3.55 | large/icon only
light | s-verified | bg-surface | #0d9488 | #ffffff | 3.74 | large/icon only
light | s-verified | bg-raised | #0d9488 | #f0f3f7 | 3.36 | large/icon only
light | s-verified | brand-subtle | #0d9488 | #e0f5f2 | 3.30 | large/icon only
light | on-brand | brand | #ffffff | #0d9488 | 3.74 | large/icon only
light | border-default (input edge, non-text) | bg-surface | #d0d7e0 | #ffffff | 1.45 | FAIL
102 pairs; 31 under 4.5:1; 3 under 3:1
```

**What this means.**

- **Under 3:1 (fails even for large text and icons):**
  - the white text on the dark-theme stale colour (`#fff` on `#f87171`, 2.77), used by the alert count badge and the danger button;
  - input borders against the surface in both themes (1.53 dark, 1.45 light). WCAG 1.4.11 asks 3:1 for the boundary of a component that is needed to identify it. Whether the field background alone is enough is a design call.
- **Dark theme:**
  - `text-tertiary` (hints, disabled text) is between 3.33 and 4.27 on every background, so it is not usable for body-size text;
  - `s-tombstoned` is between 3.15 and 4.04.
- **Light theme:**
  - `brand` and `s-verified` (both #0d9488) are 3.30 to 3.74, so links and verified marks in body text fail;
  - `s-confirmed` (#059669) is 3.32 to 3.77;
  - white text on the light brand button (`on-brand` on `brand`) is 3.74, so a primary button label at 14 px fails AA unless it counts as large text;
  - the stale, superseded, tombstoned and contested colours fall just under 4.5 on `bg-raised` and `brand-subtle`.
- **Next step.** These results are for the designer choosing the final palette. No colour was changed (the brief forbids a palette).

<details>
<summary>Full script output (102 pairs)</summary>

```text
theme | foreground | background | fg | bg | ratio | verdict
dark | text-primary | bg-canvas | #e8edf2 | #0b0f14 | 16.32 | AA body
dark | text-primary | bg-surface | #e8edf2 | #11171e | 15.30 | AA body
dark | text-primary | bg-raised | #e8edf2 | #18202a | 13.94 | AA body
dark | text-primary | brand-subtle | #e8edf2 | #0f2b2a | 12.74 | AA body
dark | text-secondary | bg-canvas | #9aa7b5 | #0b0f14 | 7.84 | AA body
dark | text-secondary | bg-surface | #9aa7b5 | #11171e | 7.35 | AA body
dark | text-secondary | bg-raised | #9aa7b5 | #18202a | 6.70 | AA body
dark | text-secondary | brand-subtle | #9aa7b5 | #0f2b2a | 6.12 | AA body
dark | text-tertiary | bg-canvas | #6b7887 | #0b0f14 | 4.27 | large/icon only
dark | text-tertiary | bg-surface | #6b7887 | #11171e | 4.00 | large/icon only
dark | text-tertiary | bg-raised | #6b7887 | #18202a | 3.65 | large/icon only
dark | text-tertiary | brand-subtle | #6b7887 | #0f2b2a | 3.33 | large/icon only
dark | brand | bg-canvas | #2dd4bf | #0b0f14 | 10.32 | AA body
dark | brand | bg-surface | #2dd4bf | #11171e | 9.68 | AA body
dark | brand | bg-raised | #2dd4bf | #18202a | 8.82 | AA body
dark | brand | brand-subtle | #2dd4bf | #0f2b2a | 8.06 | AA body
dark | s-proposed | bg-canvas | #60a5fa | #0b0f14 | 7.56 | AA body
dark | s-proposed | bg-surface | #60a5fa | #11171e | 7.09 | AA body
dark | s-proposed | bg-raised | #60a5fa | #18202a | 6.46 | AA body
dark | s-proposed | brand-subtle | #60a5fa | #0f2b2a | 5.90 | AA body
dark | s-confirmed | bg-canvas | #34d399 | #0b0f14 | 10.00 | AA body
dark | s-confirmed | bg-surface | #34d399 | #11171e | 9.38 | AA body
dark | s-confirmed | bg-raised | #34d399 | #18202a | 8.54 | AA body
dark | s-confirmed | brand-subtle | #34d399 | #0f2b2a | 7.81 | AA body
dark | s-contested | bg-canvas | #fbbf24 | #0b0f14 | 11.51 | AA body
dark | s-contested | bg-surface | #fbbf24 | #11171e | 10.80 | AA body
dark | s-contested | bg-raised | #fbbf24 | #18202a | 9.84 | AA body
dark | s-contested | brand-subtle | #fbbf24 | #0f2b2a | 8.99 | AA body
dark | s-stale | bg-canvas | #f87171 | #0b0f14 | 6.95 | AA body
dark | s-stale | bg-surface | #f87171 | #11171e | 6.52 | AA body
dark | s-stale | bg-raised | #f87171 | #18202a | 5.94 | AA body
dark | s-stale | brand-subtle | #f87171 | #0f2b2a | 5.43 | AA body
dark | s-superseded | bg-canvas | #94a3b8 | #0b0f14 | 7.50 | AA body
dark | s-superseded | bg-surface | #94a3b8 | #11171e | 7.03 | AA body
dark | s-superseded | bg-raised | #94a3b8 | #18202a | 6.40 | AA body
dark | s-superseded | brand-subtle | #94a3b8 | #0f2b2a | 5.85 | AA body
dark | s-tombstoned | bg-canvas | #64748b | #0b0f14 | 4.04 | large/icon only
dark | s-tombstoned | bg-surface | #64748b | #11171e | 3.79 | large/icon only
dark | s-tombstoned | bg-raised | #64748b | #18202a | 3.45 | large/icon only
dark | s-tombstoned | brand-subtle | #64748b | #0f2b2a | 3.15 | large/icon only
dark | s-expired | bg-canvas | #a78bfa | #0b0f14 | 7.06 | AA body
dark | s-expired | bg-surface | #a78bfa | #11171e | 6.62 | AA body
dark | s-expired | bg-raised | #a78bfa | #18202a | 6.03 | AA body
dark | s-expired | brand-subtle | #a78bfa | #0f2b2a | 5.51 | AA body
dark | s-verified | bg-canvas | #2dd4bf | #0b0f14 | 10.32 | AA body
dark | s-verified | bg-surface | #2dd4bf | #11171e | 9.68 | AA body
dark | s-verified | bg-raised | #2dd4bf | #18202a | 8.82 | AA body
dark | s-verified | brand-subtle | #2dd4bf | #0f2b2a | 8.06 | AA body
dark | on-brand | brand | #04201d | #2dd4bf | 9.18 | AA body
dark | #fff (app.css .badge-n, .btn.danger.solid) | s-stale | #ffffff | #f87171 | 2.77 | FAIL
dark | border-default (input edge, non-text) | bg-surface | #2b3948 | #11171e | 1.53 | FAIL
light | text-primary | bg-canvas | #0f1720 | #f7f9fb | 17.10 | AA body
light | text-primary | bg-surface | #0f1720 | #ffffff | 18.05 | AA body
light | text-primary | bg-raised | #0f1720 | #f0f3f7 | 16.21 | AA body
light | text-primary | brand-subtle | #0f1720 | #e0f5f2 | 15.91 | AA body
light | text-secondary | bg-canvas | #4a5766 | #f7f9fb | 6.99 | AA body
light | text-secondary | bg-surface | #4a5766 | #ffffff | 7.38 | AA body
light | text-secondary | bg-raised | #4a5766 | #f0f3f7 | 6.63 | AA body
light | text-secondary | brand-subtle | #4a5766 | #e0f5f2 | 6.50 | AA body
light | text-tertiary | bg-canvas | #5f6c7b | #f7f9fb | 5.08 | AA body
light | text-tertiary | bg-surface | #5f6c7b | #ffffff | 5.36 | AA body
light | text-tertiary | bg-raised | #5f6c7b | #f0f3f7 | 4.82 | AA body
light | text-tertiary | brand-subtle | #5f6c7b | #e0f5f2 | 4.73 | AA body
light | brand | bg-canvas | #0d9488 | #f7f9fb | 3.55 | large/icon only
light | brand | bg-surface | #0d9488 | #ffffff | 3.74 | large/icon only
light | brand | bg-raised | #0d9488 | #f0f3f7 | 3.36 | large/icon only
light | brand | brand-subtle | #0d9488 | #e0f5f2 | 3.30 | large/icon only
light | s-proposed | bg-canvas | #2563eb | #f7f9fb | 4.90 | AA body
light | s-proposed | bg-surface | #2563eb | #ffffff | 5.17 | AA body
light | s-proposed | bg-raised | #2563eb | #f0f3f7 | 4.64 | AA body
light | s-proposed | brand-subtle | #2563eb | #e0f5f2 | 4.56 | AA body
light | s-confirmed | bg-canvas | #059669 | #f7f9fb | 3.57 | large/icon only
light | s-confirmed | bg-surface | #059669 | #ffffff | 3.77 | large/icon only
light | s-confirmed | bg-raised | #059669 | #f0f3f7 | 3.39 | large/icon only
light | s-confirmed | brand-subtle | #059669 | #e0f5f2 | 3.32 | large/icon only
light | s-contested | bg-canvas | #b45309 | #f7f9fb | 4.76 | AA body
light | s-contested | bg-surface | #b45309 | #ffffff | 5.02 | AA body
light | s-contested | bg-raised | #b45309 | #f0f3f7 | 4.51 | AA body
light | s-contested | brand-subtle | #b45309 | #e0f5f2 | 4.43 | large/icon only
light | s-stale | bg-canvas | #dc2626 | #f7f9fb | 4.58 | AA body
light | s-stale | bg-surface | #dc2626 | #ffffff | 4.83 | AA body
light | s-stale | bg-raised | #dc2626 | #f0f3f7 | 4.34 | large/icon only
light | s-stale | brand-subtle | #dc2626 | #e0f5f2 | 4.26 | large/icon only
light | s-superseded | bg-canvas | #64748b | #f7f9fb | 4.51 | AA body
light | s-superseded | bg-surface | #64748b | #ffffff | 4.76 | AA body
light | s-superseded | bg-raised | #64748b | #f0f3f7 | 4.28 | large/icon only
light | s-superseded | brand-subtle | #64748b | #e0f5f2 | 4.20 | large/icon only
light | s-tombstoned | bg-canvas | #64748b | #f7f9fb | 4.51 | AA body
light | s-tombstoned | bg-surface | #64748b | #ffffff | 4.76 | AA body
light | s-tombstoned | bg-raised | #64748b | #f0f3f7 | 4.28 | large/icon only
light | s-tombstoned | brand-subtle | #64748b | #e0f5f2 | 4.20 | large/icon only
light | s-expired | bg-canvas | #7c3aed | #f7f9fb | 5.40 | AA body
light | s-expired | bg-surface | #7c3aed | #ffffff | 5.70 | AA body
light | s-expired | bg-raised | #7c3aed | #f0f3f7 | 5.12 | AA body
light | s-expired | brand-subtle | #7c3aed | #e0f5f2 | 5.02 | AA body
light | s-verified | bg-canvas | #0d9488 | #f7f9fb | 3.55 | large/icon only
light | s-verified | bg-surface | #0d9488 | #ffffff | 3.74 | large/icon only
light | s-verified | bg-raised | #0d9488 | #f0f3f7 | 3.36 | large/icon only
light | s-verified | brand-subtle | #0d9488 | #e0f5f2 | 3.30 | large/icon only
light | on-brand | brand | #ffffff | #0d9488 | 3.74 | large/icon only
light | #fff (app.css .badge-n, .btn.danger.solid) | s-stale | #ffffff | #dc2626 | 4.83 | AA body
light | border-default (input edge, non-text) | bg-surface | #d0d7e0 | #ffffff | 1.45 | FAIL

102 pairs; 31 under 4.5:1; 3 under 3:1
```

</details>
