# Design report: index

A report, not a design. It gives a designer, a copywriter and a front-end engineer what they need for the dashboard and the whole website: what Buiry is, what is proven, what exists in the build, and what is still open.

- No final copy, palette or code.
- Every product claim carries an evidence level and a file path. The levels are defined at the top of `01-product-and-proof.md`.
- Screenshots in `.buiry-local/design-shots/` (gitignored) show mock sample data (BD28). They show layout, not proof.

## Contents

| File                                                         | Sections                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [01-product-and-proof.md](01-product-and-proof.md)           | 1. Product in plain words · 2. Audiences · 3. Feature inventory · 4. The proof we actually have |
| [02-dashboard-and-system.md](02-dashboard-and-system.md)     | 5. The dashboard as it exists · 6. The design system as it exists (with contrast results)       |
| [03-site-and-messaging.md](03-site-and-messaging.md)         | 7. Website map · 8. Messaging inputs                                                            |
| [04-motion-assets-and-tech.md](04-motion-assets-and-tech.md) | 9. Motion and assets · 10. Front-end constraints · 11. Reference-site brief                     |
| [05-decisions-and-gaps.md](05-decisions-and-gaps.md)         | 12. Open decisions for the owner · 13. Method, gaps and conflicts                               |

## The five decisions that block the next documents most

Full list with recommendations in section 12.

1. **Positioning and primary audience.** The copy deck, home page hierarchy and proof selection all depend on it. Recommendation: the solo developer using several agents (P1), with the trust story as the second layer.
2. **What the site may say about testnet versus Mainnet.** Every proof point is testnet. Until this is decided, no proof can be written. Recommendation: say "verified on Sui testnet" everywhere, and put a status line on the home page.
3. **Site visibility: private preview or public.** This decides whether sign-up calls to action can exist, given that the shared managed account is single-tenant (BD41). Recommendation: a private preview behind an invite until the AWS deployment and L-BYO1 pass.
4. **Brand: name, wordmark and visual direction.** The palette and type in `docs/04-ui-spec.md` are proposals; no brand identity is agreed. Recommendation: keep the name; commission the wordmark before the palette.
5. **Install and open-source story.** This needs npm names confirmed (BD39) and the licence re-read (BD1). Until then the site cannot show an install command or an open-source section.

## What to prepare

- **Reference sites.** Three to five each for: a developer-tool landing page, a pricing page (even if pricing stays hidden), a docs hub, a dense data dashboard, and a motion style. Section 11 has the checklist of what each should answer.
- **Brand preferences.**
  - Words the brand should and should not feel like.
  - Colours or typefaces you like or dislike.
  - Whether dark-first stays (today the dashboard defaults to dark; `apps/dashboard/src/lib/app.tsx:17`).
- **Permissions and naming.**
  - Confirm that Walrus, Sui, Tatum, Claude Code, OpenCode, Cursor and Codex are mentioned as plain text only, with no logos (the brief's rule).
  - Say whether any partner logo permission exists. None is recorded in the repo.
- **Legal inputs.** Company or owner name for the legal pages, a contact address for security reports, and whether privacy and terms pages are drafted by a lawyer.
- **Domain.** The public domain, also needed for `BUIRY_BASE_URL` and the AWS deployment (L-AWS2).

## Phase 0 housekeeping done before this report

- `HANDOFF.md` is now current state only; history moved to `Development.md`.
- Status notes were added to `docs/01`–`03`.
- Two report-only sweeps were appended to `docs/SECURITY_REVIEW.md`.
- L-PG1 (migrations on real Postgres 16) was added to `LOCAL_CHECKS.md`; it passed on 2026-11-18 (43 tests, PostgreSQL 16.15).

Details are in `Development.md`.
