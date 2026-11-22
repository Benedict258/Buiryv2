/**
 * Drives the built dashboard against the development server and saves a screenshot of every screen, in dark
 * and light themes, plus a phone-width pass. It also fails on console errors and failed API requests.
 *
 *   pnpm --filter @buiry/dashboard build
 *   pnpm dev:api     # in another terminal; serves apps/dashboard/dist and prints the ids
 *   pnpm tsx scripts/dashboard-shots.ts <session-token> <workspace-id> <project-id> [outDir]
 *
 * SHOTS_PASSES (Phase 9 D5/D9), for example "dark:390x844,light:1280x800": theme and viewport per pass. Each screen
 * is also measured for horizontal overflow (content wider than the viewport, outside intentional scroll areas);
 * the findings are written to <outDir>/layout.json and printed, without failing the run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [token, ws, pid, out = '.buiry-local/shots'] = process.argv.slice(2);
if (!token || !ws || !pid) {
  console.error('usage: dashboard-shots.ts <session-token> <workspace-id> <project-id> [outDir]');
  process.exit(2);
}
const base = process.env.DASHBOARD_URL ?? 'http://localhost:8787';
const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
mkdirSync(out, { recursive: true });

const screens = [
  ['projects', `/w/${ws}/projects`],
  ['overview', `/w/${ws}/p/${pid}/overview`],
  ['memory', `/w/${ws}/p/${pid}/memory`],
  ['memory-review', `/w/${ws}/p/${pid}/memory`, 'review'],
  ['timeline', `/w/${ws}/p/${pid}/timeline`],
  ['branches', `/w/${ws}/p/${pid}/branches`],
  ['agents', `/w/${ws}/p/${pid}/agents`],
  ['activity', `/w/${ws}/p/${pid}/activity`],
  ['alerts', `/w/${ws}/p/${pid}/alerts`],
  ['verification', `/w/${ws}/p/${pid}/verification`],
  ['handoffs', `/w/${ws}/p/${pid}/handoffs`],
  ['briefing', `/w/${ws}/p/${pid}/briefing`],
  ['packs', `/w/${ws}/p/${pid}/packs`],
  ['storage', `/w/${ws}/p/${pid}/storage`],
  ['settings', `/w/${ws}/p/${pid}/settings`],
  ['team', `/w/${ws}/team`],
  ['integrations', `/w/${ws}/integrations`],
  ['api', `/w/${ws}/api`],
  ['billing', `/w/${ws}/billing`],
  ['account', `/w/${ws}/account`],
  ['notifications', `/w/${ws}/notifications`],
  ['showcase', `/showcase/${pid}`],
  ['onboarding', '/onboarding'],
] as const;

/** The live stream keeps the network busy, so wait for the skeletons to clear instead of network idle. */
async function settled(page: import('playwright-core').Page) {
  await page.waitForLoadState('load');
  await page.waitForSelector('[aria-busy="true"]', { state: 'detached', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const problems: string[] = [];
const layout: { pass: string; screen: string; scrollWidth: number; width: number; offenders: string[] }[] =
  [];

/** Elements whose right edge passes the viewport, ignoring those inside a horizontally scrolling or clipping box. */
/**
 * Content cut off or pushed off screen: an element whose right edge passes the box that clips or scrolls it (or the
 * viewport), reported at its outermost level. Table scroll areas (.tbl-wrap) and intentional ellipsis (.trunc,
 * .clamp2) are excluded.
 */
async function overflow(page: import('playwright-core').Page) {
  // Runs in the page; a string, because the scripts compile without DOM types.
  const fn = [
    '(() => {',
    '  const vw = window.innerWidth;',
    "  const clipper = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return p; } return null; };",
    // Inner scroll areas (tab bars, code blocks) are reachable by scrolling; the page's main area is not meant to scroll sideways.
    "  const reachable = (c) => !!c && !c.classList.contains('main') && ['auto', 'scroll'].includes(getComputedStyle(c).overflowX);",
    "  const skip = (e) => !!e.closest('.tbl-wrap, .trunc, .clamp2, .menu, [role=dialog], .drawer, .toast') || (e.tagName.toLowerCase() !== 'svg' && !!e.closest('svg'));",
    '  const cut = (e) => { const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0) || skip(e)) return false; const c = clipper(e); if (reachable(c)) return false; const edge = c ? Math.min(c.getBoundingClientRect().right, vw) : vw; return r.right > edge + 1; };',
    "  const all = [...document.querySelectorAll('body *')].filter(cut);",
    '  const outer = all.filter((e) => !all.includes(e.parentElement));',
    "  const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(' ').slice(0, 2).join('.') : '') + ' right=' + Math.round(e.getBoundingClientRect().right);",
    '  return { scrollWidth: document.documentElement.scrollWidth, width: vw, offenders: outer.slice(0, 6).map(name) };',
    '})()',
  ].join(' ');
  return page.evaluate(fn) as Promise<{ scrollWidth: number; width: number; offenders: string[] }>;
}
async function pass(theme: 'dark' | 'light', width: number, height: number, tag: string) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // Content Security Policy violations, enforced or Report-Only, become console errors and so count as problems.
  await ctx.addInitScript(
    `document.addEventListener('securitypolicyviolation', (e) => console.error('[csp ' + e.disposition + '] ' + e.effectiveDirective + ' blocked ' + (e.blockedURI || 'inline') + ' at ' + location.pathname));`,
  );
  await ctx.addInitScript(
    `localStorage.setItem('buiry.token', ${JSON.stringify(token)}); localStorage.setItem('buiry.theme', ${JSON.stringify(theme)});`,
  );
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()))
      problems.push(`[${tag}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/v1/') && !r.url().includes('/stream') && r.status() >= 400)
      problems.push(`[${tag}] ${r.status()} ${r.url()}`);
  });
  for (const [name, path, mode] of screens) {
    await page.goto(base + path, { waitUntil: 'load' });
    await settled(page);
    if (mode === 'review') await page.getByRole('button', { name: 'Review queue' }).click();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: false });
    const o = await overflow(page);
    if (o.scrollWidth > o.width + 1 || o.offenders.length) layout.push({ pass: tag, screen: name, ...o });
  }
  // briefing "why this item" popover and the invitations tab
  await page.goto(`${base}/w/${ws}/p/${pid}/briefing`, { waitUntil: 'load' });
  await settled(page);
  await page.getByRole('button', { name: 'Why this item?' }).first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${tag}-briefing-why.png` });
  await page.goto(`${base}/w/${ws}/team`, { waitUntil: 'load' });
  await settled(page);
  await page.getByRole('tab', { name: /^Invitations/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${tag}-team-invitations.png` });
  // memory drawer with each tab, and the editor
  await page.goto(`${base}/w/${ws}/p/${pid}/memory`, { waitUntil: 'load' });
  await settled(page);
  await page.locator('tbody tr').first().click();
  await page.waitForTimeout(500);
  for (const t of ['Overview', 'Evidence', 'Lineage', 'Provenance', 'History']) {
    await page.getByRole('tab', { name: new RegExp(`^${t}`) }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${tag}-drawer-${t.toLowerCase()}.png` });
  }
  await page.keyboard.press('Escape');
  if (width >= 768) {
    await page.getByRole('button', { name: 'New memory' }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${tag}-editor.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${tag}-palette.png` });
  }
  await ctx.close();
}
const passes = (process.env.SHOTS_PASSES ?? 'dark:1440x900,light:1440x900,dark:390x844')
  .split(',')
  .map((p) => {
    const [theme, size] = p.split(':') as ['dark' | 'light', string];
    const [w, h] = size.split('x').map(Number) as [number, number];
    return { theme, w, h, tag: `${theme}-${w}` };
  });
for (const p of passes) await pass(p.theme, p.w, p.h, p.tag);
await browser.close();
writeFileSync(`${out}/layout.json`, JSON.stringify(layout, null, 2));
for (const l of layout)
  console.log(
    `[layout] ${l.pass} ${l.screen}: scrollWidth ${l.scrollWidth} > ${l.width}; ${l.offenders.join(', ')}`,
  );
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`screenshots written to ${out}`);
