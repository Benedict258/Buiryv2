/**
 * Accessibility checks for the dashboard (Phase 9 D8), against the development server like dashboard-shots.ts:
 *
 *   pnpm tsx scripts/dashboard-a11y.ts <session-token> <workspace-id> <project-id> [outFile]
 *
 * - Keyboard: tabs through the Overview and Memory pages; every focused element must show a visible focus ring
 *   (outline at least 2px, not "none") and be a real control or carry a role.
 * - Reduced motion: with prefers-reduced-motion, transitions and animations compute to 0s.
 * - 200% zoom: a 1280x800 window at 200% is a 640x400 CSS viewport at scale 2; nothing may push the page sideways.
 * Writes the findings as JSON; exits 1 if any check fails. Checks it does not cover are listed in the Phase 9 report.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [token, ws, pid, outFile = '.buiry-local/screenshots/a11y.json'] = process.argv.slice(2);
if (!token || !ws || !pid) {
  console.error('usage: dashboard-a11y.ts <session-token> <workspace-id> <project-id> [outFile]');
  process.exit(2);
}
const base = process.env.DASHBOARD_URL ?? 'http://localhost:8787';
const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const fails: string[] = [];
const report: Record<string, unknown> = {};

async function context(o: Parameters<typeof browser.newContext>[0] = {}, theme = 'dark') {
  const ctx = await browser.newContext(o);
  await ctx.addInitScript(
    `localStorage.setItem('buiry.token', ${JSON.stringify(token)}); localStorage.setItem('buiry.theme', ${JSON.stringify(theme)});`,
  );
  return ctx;
}

// Keyboard and visible focus, both themes.
for (const theme of ['dark', 'light']) {
  const ctx = await context({ viewport: { width: 1280, height: 800 } }, theme);
  const page = await ctx.newPage();
  for (const path of [`/w/${ws}/p/${pid}/overview`, `/w/${ws}/p/${pid}/memory`]) {
    await page.goto(base + path, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    // A skip link comes first and moves focus to the page content (Phase 9 D8).
    await page.keyboard.press('Tab');
    const first = (await page.evaluate(
      '(document.activeElement && document.activeElement.textContent || "").trim()',
    )) as string;
    if (first !== 'Skip to content')
      fails.push(`[${theme}] ${path}: first Tab lands on "${first.slice(0, 40)}", not a skip link`);
    else {
      await page.keyboard.press('Enter');
      const into = (await page.evaluate(
        '!!(document.activeElement && document.activeElement.closest("#main"))',
      )) as boolean;
      if (!into) fails.push(`[${theme}] ${path}: the skip link does not move focus into the page content`);
      await page.goto(base + path, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
    }
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const f = (await page.evaluate(
        [
          '(() => { const e = document.activeElement; if (!e || e === document.body) return null;',
          ' const s = getComputedStyle(e);',
          " const name = e.tagName.toLowerCase() + (e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : '') + ' ' + (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30);",
          " const interactive = ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(e.tagName.toLowerCase()) || e.hasAttribute('role') || e.tabIndex >= 0;",
          " return { name, outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor, offset: s.outlineOffset, visible: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2, interactive }; })()",
        ].join(''),
      )) as { name: string; outline: string; offset: string; visible: boolean; interactive: boolean } | null;
      if (!f) continue;
      seen.push(`${f.name} | ${f.outline} | offset ${f.offset}`);
      if (!f.visible) fails.push(`[${theme}] ${path}: focus not visible on ${f.name} (${f.outline})`);
      if (!f.interactive) fails.push(`[${theme}] ${path}: focus on a non-control ${f.name}`);
    }
    report[`keyboard ${theme} ${path}`] = seen;
  }
  await ctx.close();
}

// Reduced motion.
{
  const ctx = await context({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${base}/w/${ws}/p/${pid}/memory`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const moving = (await page.evaluate(
    "[...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return parseFloat(s.transitionDuration) > 0 || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0); }).slice(0, 10).map((e) => e.tagName.toLowerCase() + '.' + String(e.className))",
  )) as string[];
  report['reduced motion: elements still animating'] = moving;
  for (const m of moving) fails.push(`reduced motion: ${m} still animates`);
  await ctx.close();
}

// 200% zoom: 640x400 CSS pixels at scale 2.
{
  const ctx = await context({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const wide: string[] = [];
  for (const s of [
    'projects',
    'overview',
    'memory',
    'agents',
    'verification',
    'storage',
    'settings',
    'briefing',
  ]) {
    const path = s === 'projects' ? `/w/${ws}/projects` : `/w/${ws}/p/${pid}/${s}`;
    await page.goto(base + path, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const sw = (await page.evaluate('document.documentElement.scrollWidth')) as number;
    if (sw > 641) wide.push(`${s}: scrollWidth ${sw}`);
    await page.screenshot({ path: outFile.replace(/a11y\.json$/, `zoom200-${s}.png`) });
  }
  report['200% zoom: pages wider than the window'] = wide;
  for (const w of wide) fails.push(`200% zoom: ${w}`);
  await ctx.close();
}

await browser.close();
writeFileSync(outFile, JSON.stringify({ fails, report }, null, 2));
console.log(fails.length ? fails.join('\n') : 'a11y checks passed');
console.log(`written to ${outFile}`);
if (fails.length) process.exit(1);
