# 04. Motion, assets and front-end constraints (sections 9 to 11)

Part of the design report (`00-index.md`). Statements marked **opinion** are recommendations, not facts from the repo.

## 9. Motion and asset inventory

### Rules for motion

- Motion only where it shows something true about the product.
- Every animated story must match the real sequence in the code or the records, using the code names from section 8.
- Every item needs a reduced-motion fallback.
- The dashboard already removes animation under `prefers-reduced-motion` (`apps/dashboard/src/styles/app.css`, the reduce media query). Its current animations are:
  - `flash 0.8s` for live rows;
  - `pulse 1.4s` for the live indicator;
  - `slide 160ms` for drawers;
  - `spin 0.7s` for loading.
- The spec asks for 120 to 200 ms ease-out on interface changes (`docs/04-ui-spec.md` section 2).

Duration ranges below are **opinion**, within the spec's guidance for interface motion. Marketing illustrations may run longer.

| Item                                | Purpose                                    | Trigger                                   | Duration range (opinion)              | Reduced-motion fallback             | Data or story it must show accurately                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------- | ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero: two agents sharing one memory | Show the core promise                      | Page load or scroll into view; plays once | 6 to 12 s total, in steps             | Static three-panel diagram          | Agent A records a `failure` and a `handoff`; agent B's `buiry_check` briefing lists the failure first (L-D1 stage 2). Two different agent identities; never imply real Cursor or Codex use. |
| Proposed to confirmed               | Explain trust levels                       | Hover or step in "How it works"           | 200 to 400 ms per state               | Two static chips with an arrow      | Agent writes `proposed` (0.35); a person, or another session's helpful reports, confirm it. An agent never confirms its own (BD9, BD11).                                                    |
| Stale flag on package upgrade       | Show drift detection                       | Step in the story                         | 1 to 3 s                              | Before and after frames             | Package v1 cited, then upgraded to v2; `buiry_verify` says "package upgraded: cited version 1, latest 2"; the status becomes `stale` and a flag is raised (L-D1 stage 3).                   |
| Briefing assembling                 | Show that a briefing is chosen, not dumped | Scroll into view                          | 1 to 2 s                              | The final briefing list with scores | Items picked within a token budget; the untrusted-data preamble first; scores visible to people only (BD29), never to agents.                                                               |
| Confidence meter change             | Show earned confidence                     | On report or verify event                 | 200 to 400 ms                         | Number change only                  | Rises with verified evidence (cap 0.9) and helpful reports (two per day); decays by type over time.                                                                                         |
| Live feed rows                      | Show live activity in the dashboard        | SSE event                                 | 800 ms highlight (exists)             | No highlight, row inserted          | Real activity rows only; no invented events.                                                                                                                                                |
| Handoffs                            | Show continuity between sessions           | Step in the story                         | 0.5 to 1.5 s                          | Static card linking two sessions    | `buiry_handoff` at session end; read first by the next `buiry_check`.                                                                                                                       |
| Branches and merge lineage          | Explain memory branches                    | Branch page or "How it works"             | 1 to 2 s                              | Static lineage diagram              | A merge writes new memories into the target and marks the replaced ones `superseded` (Branches page wording).                                                                               |
| Evidence verify                     | Show a chain check                         | Click "Re-verify" or a story step         | 300 ms to 1 s, plus a real wait       | Spinner replaced by result text     | gRPC read; result `verified`, `failed` or `unknown`. `unknown` is never shown as a pass (A8). Real latency is about 0.3 s once connected, longer on first call (L-T5).                      |
| Page and drawer transitions         | Orientation                                | Navigation                                | 120 to 200 ms (spec)                  | None                                | n/a                                                                                                                                                                                         |
| Loading and empty states            | Calm waiting                               | Fetch                                     | Skeleton; spinner 0.7 s loop (exists) | Static skeleton                     | Empty states use the real wording (section 5).                                                                                                                                              |

### Assets

| Asset                                   | Where used                     | Format                                                  | Size and performance budget (opinion)                    | Generated from code, or needs a designer                                           |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Logo and wordmark options               | Site header, app shell, social | SVG                                                     | under 5 KiB each                                         | Designer (no identity agreed; `04-ui-spec.md` section 1)                           |
| Favicon and app icons                   | Browser tabs, PWA icons if any | SVG plus PNG 32, 180, 192, 512                          | under 2 KiB SVG                                          | Designer, then generated. A placeholder `favicon.svg` exists (0.2 KiB).            |
| Architecture diagram                    | How it works, Docs             | SVG (inline)                                            | under 30 KiB                                             | From code: `docs/diagrams/architecture.mmd` exists (Mermaid); styled by a designer |
| Data-flow diagram (write, read, verify) | How it works                   | SVG                                                     | under 30 KiB                                             | From code, using the flow in `ARCHITECT_BRIEFING.md` section 5                     |
| Trust-boundary diagram                  | Security and trust             | SVG                                                     | under 30 KiB                                             | Designer, from `docs/01-whitepaper.md` (trust boundary) and A26                    |
| Session lifecycle diagram               | Home, Docs                     | SVG or Lottie                                           | under 60 KiB                                             | Designer                                                                           |
| Hero illustration or animation          | Home                           | SVG with CSS, or Rive or Lottie                         | under 150 KiB including runtime; first paint not blocked | Designer                                                                           |
| Section illustrations                   | Features                       | SVG                                                     | under 20 KiB each                                        | Designer                                                                           |
| Screenshots and annotated crops         | Features, Docs                 | WebP or AVIF with PNG fallback                          | under 150 KiB each at 2x                                 | From code: `scripts/dashboard-shots.ts`. Label "sample data" (BD28).               |
| Social and Open Graph images            | Link previews                  | PNG 1200 × 630                                          | under 300 KiB                                            | Designer template; could be generated per page                                     |
| Empty-state graphics                    | App and site                   | SVG                                                     | under 5 KiB each                                         | Designer; today empty states use icons only                                        |
| Icon set                                | App and site                   | `lucide-react` 1.61.0 (ISC)                             | tree-shaken                                              | Exists                                                                             |
| 3D or abstract motifs                   | Optional                       | SVG or CSS; avoid WebGL                                 | under 50 KiB                                             | Designer. The spec says "no 3D, no gradients" for data visuals.                    |
| Demo video or GIF                       | Home, How it works             | MP4 or WebM (no GIF), with poster image                 | under 3 MB, lazy-loaded                                  | Recorded from a real testnet run, with the network shown on screen                 |
| Fonts                                   | Everywhere                     | Self-hosted WOFF2 (Inter, JetBrains Mono, both OFL-1.1) | latin subsets about 87 KiB together (measured below)     | Exists (fontsource 5.3.0)                                                          |

### Motion technology: recommendation and trade-offs (opinion unless marked)

| Approach                               | Trade-offs                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSS transitions and keyframes (exists) | No runtime cost, CSP-friendly, already used and covered by the reduced-motion rule (verified in `app.css`). Limited for sequenced stories.                          |
| SVG with CSS or the Web Animations API | Small, CSP-friendly, accessible text stays text. Good for diagrams that animate step by step.                                                                       |
| Lottie                                 | Designer-friendly (After Effects). The player adds a runtime (size UNVERIFIED here). Some players evaluate expressions, which affects CSP. JSON files can be large. |
| Rive                                   | Interactive state machines. WebAssembly runtime (size UNVERIFIED here); needs `wasm-unsafe-eval` or equivalent in CSP (UNVERIFIED; check the vendor docs).          |
| Video                                  | Best for a real recorded demo. Heavy, not interactive, needs captions.                                                                                              |

**Recommendation (opinion):**

- Use CSS and SVG for the dashboard and for diagrams.
- Use one recorded video for the real demo.
- Consider Lottie or Rive only for the home hero, if the designer needs it. Measure the runtime size against the budget in section 10 before choosing.

## 10. Front-end technical constraints

### Current stack and build (verified from the repo)

- **Stack.** Vite 6.4.5 with React 18.3.1, TypeScript and React Router 7.18.5. Hand-written CSS driven by tokens; no UI framework (BD23).
- **Build.** `pnpm --filter @buiry/dashboard build` writes `apps/dashboard/dist`.
- **Serving.** The API server serves the build at `/` when `DASHBOARD_DIR` is set (BD24), with an SPA fallback to `index.html` (`packages/api/src/server.ts:240`–`:257`):
  - hashed assets under `assets/` get `cache-control: public, max-age=31536000, immutable`;
  - everything else gets `no-cache`;
  - every response gets `x-content-type-options: nosniff`.
- **API responses** add `cache-control: no-store` and `referrer-policy: no-referrer` (`packages/api/src/http/app.ts:141`–`:143`).
- **Compression.** Since Phase 2.4 the server compresses the dashboard's text assets itself (brotli quality 9, else gzip, per `Accept-Encoding`; `packages/api/src/http/static-compression.ts`). Fonts are sent as they are.
- **Code splitting.** None: one JS chunk (no `lazy()` or dynamic `import()` in `apps/dashboard/src`).

### Measured bundle sizes (dashboard build, 2026-11-18)

**Method.** `vite build`, then a throwaway script (`bundle.cjs`, kept outside the repo) that computes raw, gzip (level 9) and brotli sizes for every file in `dist`.

**Output:**

```text
file | raw KiB | gzip KiB | brotli KiB
assets/index-CeYP--Bt.js | 405.9 | 117.9 | 100.2
assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2 | 83.1 | 83.1 | 83.1
assets/inter-latin-wght-normal-Dx4kXJAl.woff2 | 47.1 | 47.1 | 47.1
assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2 | 39.5 | 39.5 | 39.5
assets/inter-cyrillic-ext-wght-normal-BOeWTOD4.woff2 | 25.4 | 25.4 | 25.4
assets/index-BiUB3H2o.css | 23.4 | 7.1 | 6.2
assets/inter-greek-wght-normal-CkhJZR-_.woff2 | 18.6 | 18.6 | 18.6
assets/inter-cyrillic-wght-normal-DqGufNeO.woff2 | 18.3 | 18.3 | 18.3
assets/jetbrains-mono-latin-ext-wght-normal-DBQx-q_a.woff2 | 14.8 | 14.9 | 14.8
assets/jetbrains-mono-cyrillic-wght-normal-D73BlboJ.woff2 | 11.8 | 11.8 | 11.8
assets/inter-greek-ext-wght-normal-DlzME5K_.woff2 | 11.0 | 11.0 | 10.9
assets/inter-vietnamese-wght-normal-CBcvBZtf.woff2 | 10.0 | 10.0 | 10.0
assets/jetbrains-mono-greek-wght-normal-Bw9x6K1M.woff2 | 8.8 | 8.8 | 8.8
assets/jetbrains-mono-vietnamese-wght-normal-Bt-aOZkq.woff2 | 7.3 | 7.4 | 7.3
index.html | 0.5 | 0.3 | 0.2
favicon.svg | 0.2 | 0.2 | 0.2
total .js: raw 405.9 KiB, gzip 117.9 KiB, brotli 100.2 KiB
total .css: raw 23.4 KiB, gzip 7.1 KiB, brotli 6.2 KiB
total .woff2: raw 295.6 KiB, gzip 295.9 KiB, brotli 295.6 KiB
```

**Reading the output.**

- Browsers download only the font subsets a page uses (fontsource declares `unicode-range`). An English page loads about 47 KiB of Inter latin and 40 KiB of JetBrains Mono latin.
- The single JS file is 406 KiB raw. Since Phase 2.4 the server sends it brotli-compressed: **108.1 KiB** as served. The 100.2 KiB brotli figure above is from this throwaway script, which uses Node's default brotli quality (11); the server uses quality 9 to compress quickly on first request, so 108.1 KiB is the correct figure for what browsers receive. The JS file was also rebuilt in between (Phase 2.3 stopped inlining fonts), with the same raw size.

### Where the marketing site should live

| Option                                                                         | For                                                                                                                                                           | Against                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A separate app in the monorepo (for example `apps/site`), statically generated | Static HTML for search engines and first paint; its own CSP and analytics; can share `tokens.css`; deploys independently (S3 and CloudFront, or the same ALB) | A second build and deployment; shared tokens need a small shared package or a copied file                                                                            |
| Inside the dashboard SPA                                                       | One build, one deployment                                                                                                                                     | The SPA renders on the client (poor for search engines and first paint); marketing scripts would share the app's CSP and bundle; mixes public and signed-in concerns |

**Recommendation (opinion):** a separate, statically generated app in the monorepo that reuses the tokens.

### SEO and rendering

- **Marketing pages** need static generation or server rendering. The dashboard is client-rendered, which is fine behind sign-in.
- **The public showcase** (`/showcase/:pid`) is client-rendered today. If showcase pages should be indexed or previewed in link cards, they need server-side or static rendering of the public endpoint. That is a decision, not built.

### Performance budgets and Core Web Vitals (targets are opinion)

| Target                      | Marketing pages                                               | Dashboard (signed in)                                                                           |
| --------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Largest Contentful Paint    | ≤ 2.5 s on mid-range mobile                                   | ≤ 2.5 s after sign-in                                                                           |
| Interaction to Next Paint   | ≤ 200 ms                                                      | ≤ 200 ms                                                                                        |
| Cumulative Layout Shift     | ≤ 0.1                                                         | ≤ 0.1                                                                                           |
| JS transferred (compressed) | ≤ 100 KiB per page, excluding a hero runtime only if approved | today 108.1 KiB brotli as served (117.9 gzip; 406 raw); code splitting would cut the first load |
| Fonts                       | ≤ 2 families, latin subset preloaded                          | as today                                                                                        |

These are the common Web Vitals "good" thresholds; they have not been measured on the current dashboard.

### Accessibility, theming, languages

- **WCAG 2.1 AA** is the target (`docs/04-ui-spec.md` sections 2 and 11). The contrast failures in section 6 must be resolved in the final palette.
- **Theming.** The dashboard has dark (default) and light themes, stored per viewer in `localStorage`. The site should honour `prefers-color-scheme` (opinion).
- **Languages.** English only. There is no i18n framework, and all strings are inline in the components. Adding languages later means extracting strings. Section 12 has the decision.

### Analytics and cookie consent

- No analytics exists in the dashboard.
- Adding analytics to the site brings consent duties that depend on the jurisdiction and the tool. That is a legal and product decision (section 12).
- A cookieless, first-party tool would avoid a consent banner in many cases. UNVERIFIED for any jurisdiction; it needs the owner's or a lawyer's check.

### Content Security Policy

- **A CSP is enforced** on every response since Phase 2.3: `default-src 'self'` with `script-src`, `style-src`, `font-src` and `connect-src` all `'self'`, `img-src 'self' data:`, `frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and HSTS over https only (`packages/api/src/http/security-headers.ts`). 0 violations over 94 screens on the production build in Chrome 157 (2026-11-18).
- **What would require changing the CSP:**
  - **Fonts:** self-hosted today, so `font-src 'self'` works. Google Fonts or another font CDN would add origins.
  - **Animation runtimes:** Rive's WebAssembly needs `wasm-unsafe-eval`; some Lottie players need `unsafe-eval` for expressions. Both are UNVERIFIED and must be checked against the chosen versions.
  - **Analytics:** adds `script-src` and `connect-src` origins.
  - **The dashboard:** inline styles are used through React `style` attributes (187 occurrences). React sets them through the DOM style property, which CSP `style-src` does not block (UNVERIFIED in a browser). The live feed uses `fetch` to the same origin, which fits `connect-src 'self'`.
- **Recommendation (opinion):** design assets so that the dashboard and the site can run under `default-src 'self'` plus the minimum named exceptions. Add the header in the API's static handler and on the site's host.

### How the site gets live data

| Source                                 | What it gives                                                                                                                    | Constraints                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /v1/public/showcase/:id`          | Only for projects whose owner enabled it: chosen sections, confirmed memories, counts; no agent names, activity or tokens (BD31) | Its own per-address rate limit; cached 30 s (`routes-auth.ts:46`); the data lapses on testnet                  |
| `GET /v1/projects/:id/evidence-report` | Blob ids, expiry and chain-call summary                                                                                          | Requires a signed-in user (`auth: 'user'`). Not public; the site would need a static export of a chosen report |
| `GET /v1/healthz`                      | Deployment status and network                                                                                                    | Public; could drive a "testnet" status pill                                                                    |

### Hosting implications for the AWS deployment

- **Dashboard.** It ships inside the API container, served behind the ALB (`docs/DEPLOYMENT.md`).
- **A static marketing site** would need its own bucket and CDN, or an ALB rule. Neither is in `infra/aws/`, so the owner must decide.
- **Domain and certificate.** Both are owner inputs (L-AWS2). The site and the app share the domain decision, and the app's `BUIRY_BASE_URL` and allowed origins must match.

### Licence and trademark constraints on assets

- **Fonts and icons:**
  - Inter and JetBrains Mono are OFL-1.1, which permits use and self-hosting (licence field in their `package.json`);
  - Lucide is ISC.
- **Partner names.** Walrus, Sui, Tatum, Claude Code, OpenCode, Cursor and Codex appear as plain text only, with no logos (the brief's rule). No logo permission is recorded in the repo.
- **Dashboard code** is proprietary (`UNLICENSED`). Screenshots of it on the site are fine; publishing its code is not part of the open-source block.
- **Commissioned art.** Assets made by a designer need a written transfer or licence to the owner. That is an owner action.

## 11. Reference-site brief

Questions this report cannot answer. Answer each by pointing at one or more example sites; this report does not choose references.

- [ ] **Developer-tool landing page layout:**
  - How long is the home page (one screen, or a long scroll)?
  - Is there a product screenshot above the fold, or an illustration?
  - Where does the install command or the call to action sit?
- [ ] **Proof presentation:** do you prefer numbers in cards, a live embed, a recorded demo, or a written case study (ours would be the testnet run)?
- [ ] **Pricing page layout** (even if hidden for now): plan columns, a usage calculator, or "contact us"?
- [ ] **Docs layout:** a left sidebar with a table of contents on the right, a search-first layout, or an API reference style?
- [ ] **Dashboard density:** dense tables like a monitoring tool, or airy cards like a consumer app? Today the dashboard is fairly dense (section 5 screenshots).
- [ ] **Motion style:** none, subtle interface motion only, or story-driven hero animation?
- [ ] **Illustration style:** technical diagrams, abstract shapes, or product UI crops?
- [ ] **Tone of voice examples:** two sites whose wording feels right, and one that feels wrong.
- [ ] **Dark or light first for the site:** the app is dark-first today.
- [ ] **Typography:** keep Inter and JetBrains Mono, or a distinct display face for the site?
- [ ] **Trust and security page examples** you find credible.
- [ ] **Changelog and blog examples.**
