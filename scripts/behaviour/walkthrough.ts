/**
 * Dashboard walkthrough on testnet (Phase 9), in Chrome through Playwright. Starts the server on the testnet profile
 * serving the built dashboard, then as a real user: signs in by email link, goes through onboarding, lets an agent
 * write memories (stored on testnet Walrus), visits the main pages, invites a teammate, and accepts the invitation
 * as that teammate in a second browser. Screenshots go to .buiry-local/walkthrough/<stamp>/ (gitignored); none is
 * taken while a token or an invite link is on screen.
 *
 *   pnpm --filter @buiry/dashboard build
 *   pnpm tsx scripts/behaviour/walkthrough.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { RestBackend } from '../../packages/mcp/src/index.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const PORT = 8792;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROMIUM_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = join(
  ROOT,
  '.buiry-local',
  'walkthrough',
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
);
mkdirSync(OUT, { recursive: true });
const env = process.env as Record<string, string | undefined>;
// Only this public id is read from the testnet profile (no keys are loaded into this process).
const DEMO_TX =
  env.DEMO_TX_DIGEST ??
  readFileSync(join(ROOT, '.env.testnet'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DEMO_TX_DIGEST='))
    ?.slice('DEMO_TX_DIGEST='.length)
    .trim();
const steps: { step: string; ok: boolean; note?: string }[] = [];
const consoleErrors: string[] = [];
const say = (m: string) => console.log(`[walkthrough] ${m}`);
const redact = (s: string) =>
  s.replace(/token=[^\s&"]+/g, 'token=<redacted>').replace(/bry_[A-Za-z0-9_-]{8,}/g, '<token>');

const serverLog: string[] = [];
const server = spawn(
  process.execPath,
  [TSX, join(ROOT, 'scripts/with-env.ts'), 'testnet', '--', 'node', TSX, 'packages/worker/src/bin.ts'],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      BUIRY_BASE_URL: BASE,
      DASHBOARD_DIR: join(ROOT, 'apps/dashboard/dist'),
    },
  },
);
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const stop = () => {
  if (server.exitCode === null) spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F']);
};
process.on('exit', stop);
const waitLog = async (re: RegExp, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = serverLog.join('').match(re);
    if (m) return m;
    if (server.exitCode !== null) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};

let shot = 0;
const snap = async (page: Page, name: string) => {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
};
const step = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    steps.push({ step: name, ok: true, ...(note ? { note } : {}) });
    say(`ok   ${name}${note ? `: ${note}` : ''}`);
  } catch (e) {
    steps.push({ step: name, ok: false, note: redact((e as Error).message.split('\n')[0]!) });
    say(`FAIL ${name}: ${redact((e as Error).message.split('\n')[0]!)}`);
  }
};

/** Signs in through the real email flow: request a link, read it from the development mailer, open it. */
async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/signin`);
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send sign-in link' }).first().click();
  const m = await waitLog(new RegExp(`sign-in link for ${email.replace(/[.]/g, '\\.')}: (\\S+)`), 20_000);
  if (!m) throw new Error('no sign-in link in the server log');
  await page.goto(m[1]!);
  // The link lands on /auth/email, redirects to /signin, which verifies the token and moves on.
  await page.waitForURL((u) => !/^\/(signin|auth\/)/.test(u.pathname), { timeout: 20_000 });
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if ((await page.evaluate(async () => (await fetch('/v1/auth/me')).status)) === 200) return;
    await page.waitForTimeout(500);
  }
  throw new Error('signed-in session not established');
}

try {
  if (!(await waitLog(/listening on/, 180_000))) throw new Error('server did not start');
  say('server up on testnet profile');
  const browser = await chromium.launch({ executablePath: CHROME });
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  owner.on('console', (m) => m.type() === 'error' && consoleErrors.push(`owner: ${m.text()}`));
  let ws = '';
  let pid = '';

  await step('owner signs in with an email link', async () => {
    await owner.goto(`${BASE}/signin`);
    await snap(owner, 'signin');
    await signIn(owner, 'owner@example.invalid');
    await snap(owner, 'after-signin');
    return new URL(owner.url()).pathname;
  });

  await step('onboarding: workspace', async () => {
    if (!owner.url().includes('/onboarding')) await owner.goto(`${BASE}/onboarding`);
    await owner.getByLabel('Workspace name').fill('Walkthrough Labs');
    await snap(owner, 'onboarding-workspace');
    await owner.getByRole('button', { name: 'Continue' }).click();
    await owner.getByLabel('Project name').waitFor();
  });

  await step('onboarding: project with the default networks', async () => {
    await owner.getByLabel('Project name').fill('walkthrough-api');
    await snap(owner, 'onboarding-project-defaults');
    await owner.getByRole('button', { name: 'Create project' }).click();
    await owner.waitForTimeout(2500);
    await snap(owner, 'onboarding-project-default-result');
    const err = await owner.locator('.toast, [role=alert]').allInnerTexts();
    const created = !(await owner
      .getByLabel('Project name')
      .isVisible()
      .catch(() => false));
    if (!created) throw new Error(`refused with the default networks: ${err.join(' | ') || 'no message'}`);
    return 'created with the defaults';
  });

  await step('onboarding: project declaring sui:testnet', async () => {
    if (
      !(await owner
        .getByLabel('Project name')
        .isVisible()
        .catch(() => false))
    )
      return 'already created';
    const main = owner.getByLabel('sui:mainnet');
    if (await main.isChecked()) await main.uncheck();
    const test = owner.getByLabel('sui:testnet');
    if (!(await test.isChecked())) await test.check();
    await owner.getByRole('button', { name: 'Create project' }).click();
    await owner.getByLabel('Project name').waitFor({ state: 'detached', timeout: 20_000 });
    await snap(owner, 'onboarding-connect-step');
  });

  await step('onboarding: finish and open the project', async () => {
    for (let i = 0; i < 4; i++) {
      const open = owner.getByRole('button', { name: 'Open project' });
      if (await open.isVisible().catch(() => false)) {
        await open.click();
        break;
      }
      await owner.getByRole('button', { name: 'Continue' }).click();
      await owner.waitForTimeout(500);
    }
    await owner.waitForURL(/\/w\/[^/]+\/p\/[^/]+\/overview/, { timeout: 20_000 });
    const parts = new URL(owner.url()).pathname.split('/');
    ws = parts[2]!;
    pid = parts[4]!;
    await snap(owner, 'overview-empty');
  });

  await step('onboarding reused the personal workspace (no second workspace)', async () => {
    const mine = await owner.evaluate(
      async () => ((await (await fetch('/v1/auth/me')).json()) as { data: { workspaces: unknown[] } }).data,
    );
    if (mine.workspaces.length !== 1) throw new Error(`owner has ${mine.workspaces.length} workspaces`);
    return '1 workspace';
  });

  await step('an agent writes memories (stored on testnet Walrus)', async () => {
    const made = await owner.evaluate(
      async ([p]) =>
        (await (
          await fetch(`/v1/projects/${p}/agents`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: 'walkthrough-agent',
              tool: 'claude-code',
              permissions: ['read', 'write'],
            }),
          })
        ).json()) as { data: { token: string } },
      [pid],
    );
    const agent = new RestBackend({ baseUrl: BASE, token: made.data.token });
    await agent.check({ task: 'walkthrough' });
    await agent.remember({
      text: 'Use pnpm workspaces; npm hoisting broke the build in packages/api.',
      type: 'decision',
    });
    if (DEMO_TX)
      await agent.remember({
        text: 'The registry package was upgraded on testnet.',
        type: 'deployment',
        evidence: [{ kind: 'tx', digest: DEMO_TX, network: 'sui:testnet' }],
      });
    // Wait until the worker has stored both on Walrus (bounded).
    const end = Date.now() + 4 * 60_000;
    let stored = 0;
    while (Date.now() < end) {
      const s = await owner.evaluate(
        async ([p]) =>
          (await (await fetch(`/v1/projects/${p}/storage`)).json()) as { data: { storedMemories: number } },
        [pid],
      );
      stored = s.data.storedMemories;
      if (stored >= 2) break;
      await owner.waitForTimeout(10_000);
    }
    return `${stored} stored on testnet`;
  });

  for (const [name, path] of [
    ['overview', 'overview'],
    ['memory', 'memory'],
    ['verification', 'verification'],
    ['storage', 'storage'],
    ['activity', 'activity'],
    ['briefing', 'briefing'],
    ['settings', 'settings'],
  ] as const)
    await step(`page: ${name}`, async () => {
      await owner.goto(`${BASE}/w/${ws}/p/${pid}/${path}`);
      await owner
        .waitForSelector('[aria-busy="true"]', { state: 'detached', timeout: 15_000 })
        .catch(() => {});
      await snap(owner, name);
    });

  let inviteLink = '';
  await step('owner invites a teammate as writer', async () => {
    await owner.goto(`${BASE}/w/${ws}/team`);
    await snap(owner, 'team-before');
    await owner.getByRole('button', { name: 'Invite' }).first().click();
    await owner.getByLabel('Email or wallet address').fill('teammate@example.invalid');
    await owner.getByRole('button', { name: 'Create invitation' }).click();
    await owner.waitForTimeout(1500);
    inviteLink = (await owner.locator('text=/\\/invite\\/[A-Za-z0-9_-]+/').first().innerText()).trim();
    if (!/\/invite\//.test(inviteLink)) throw new Error('no invite link shown');
    return 'link shown once (not screenshotted)';
  });

  const mate = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  mate.on('console', (m) => m.type() === 'error' && consoleErrors.push(`teammate: ${m.text()}`));
  await step('teammate signs in and accepts the invitation', async () => {
    await signIn(mate, 'teammate@example.invalid');
    await mate.goto(inviteLink.startsWith('http') ? inviteLink : `${BASE}${inviteLink}`);
    await mate.waitForURL((u) => u.pathname.startsWith(`/w/${ws}`), { timeout: 20_000 });
    await snap(mate, 'teammate-joined');
    return new URL(mate.url()).pathname;
  });

  await step('owner sees the teammate as a writer', async () => {
    await owner.goto(`${BASE}/w/${ws}/team`);
    await owner.waitForTimeout(1000);
    await snap(owner, 'team-after');
    const text = await owner.locator('body').innerText();
    if (!/teammate@example\.invalid/.test(text)) throw new Error('teammate not listed');
    if (!/writer/i.test(text)) throw new Error('role not shown as writer');
  });

  await step('teammate (writer) cannot invite', async () => {
    await mate.goto(`${BASE}/w/${ws}/team`);
    await mate.waitForTimeout(1000);
    await snap(mate, 'teammate-team');
    const b = mate.getByRole('button', { name: 'Invite' }).first();
    if (!(await b.isDisabled())) throw new Error('Invite is enabled for a writer');
  });

  await step('the invitation link cannot be used twice', async () => {
    const token = inviteLink.split('/invite/')[1]!;
    const r = await mate.evaluate(
      async ([t]) =>
        (
          await fetch('/v1/invitations/accept', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: t }),
          })
        ).status,
      [token],
    );
    if (r < 400 || r === 401) throw new Error(`second accept returned HTTP ${r}`);
    return `second accept: HTTP ${r}`;
  });

  // Phase D: a second user under the single-tenant shared account gets a clear way forward, not a dead end.
  const second = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  second.on('console', (m) => m.type() === 'error' && consoleErrors.push(`second: ${m.text()}`));
  await step('second user: onboarding explains storage and preselects their own account', async () => {
    await signIn(second, 'second-tenant@example.invalid');
    await second.goto(`${BASE}/onboarding`);
    await second.getByLabel('Workspace name').fill('Second Tenant Co');
    await second.getByRole('button', { name: 'Continue' }).click();
    await second.getByLabel('Project name').waitFor();
    await second.getByText('serves another workspace').waitFor({ timeout: 10_000 });
    await second.getByLabel('Project name').fill('second-api');
    await snap(second, 'second-user-storage-step');
    const byo = second.locator('[role=radio]', { hasText: 'Bring your own account' });
    if ((await byo.getAttribute('aria-checked')) !== 'true') throw new Error('own account not preselected');
    if (!(await second.getByText('(not available here)').isVisible()))
      throw new Error('shared option not marked');
    return 'explained, own account preselected';
  });

  await step('second user: the project shows how to start storing, with a link to Storage', async () => {
    await second.getByRole('button', { name: 'Create project' }).click();
    await second.getByLabel('Project name').waitFor({ state: 'detached', timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      const open = second.getByRole('button', { name: 'Open project' });
      if (await open.isVisible().catch(() => false)) {
        await open.click();
        break;
      }
      await second.getByRole('button', { name: 'Continue' }).click();
      await second.waitForTimeout(500);
    }
    await second.waitForURL(/\/w\/[^/]+\/p\/[^/]+\/overview/, { timeout: 20_000 });
    await second.getByText('Connect a storage account').waitFor({ timeout: 10_000 });
    await snap(second, 'second-user-overview-banner');
    await second.getByText('Connect a storage account').click();
    await second.waitForURL(/\/storage$/, { timeout: 10_000 });
    await second.getByRole('button', { name: 'Use your own account' }).waitFor({ timeout: 10_000 });
    await snap(second, 'second-user-storage-page');
    const mine = await second.evaluate(
      async () => ((await (await fetch('/v1/auth/me')).json()) as { data: { workspaces: unknown[] } }).data,
    );
    if (mine.workspaces.length !== 1) throw new Error(`second user has ${mine.workspaces.length} workspaces`);
    return 'banner links to the Storage page; one workspace';
  });

  await browser.close();
} catch (e) {
  steps.push({ step: 'walkthrough', ok: false, note: redact((e as Error).message) });
} finally {
  const res = { out: OUT, steps, consoleErrors: consoleErrors.map(redact) };
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(res, null, 2));
  writeFileSync(join(OUT, 'server.log'), redact(serverLog.join('')));
  say(
    `${steps.filter((s) => s.ok).length}/${steps.length} steps ok; console errors: ${consoleErrors.length}`,
  );
  stop();
}
