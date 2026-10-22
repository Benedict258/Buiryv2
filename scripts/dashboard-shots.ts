/**
 * Drives the built dashboard against the development server and saves a screenshot of every screen, in dark
 * and light themes, plus a phone-width pass. It also fails on console errors and failed API requests.
 *
 *   pnpm --filter @buiry/dashboard build
 *   DASHBOARD_DIR=apps/dashboard/dist pnpm tsx scripts/dev-server.ts     # in another terminal; prints the ids
 *   pnpm tsx scripts/dashboard-shots.ts <session-token> <workspace-id> <project-id> [outDir]
 */
import { mkdirSync } from 'node:fs';
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
async function pass(theme: 'dark' | 'light', width: number, height: number, tag: string) {
  const ctx = await browser.newContext({ viewport: { width, height } });
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
  }
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
await pass('dark', 1440, 900, 'dark');
await pass('light', 1440, 900, 'light');
await pass('dark', 390, 844, 'phone');
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`screenshots written to ${out}`);
