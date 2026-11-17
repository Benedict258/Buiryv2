/**
 * Post-deploy smoke test against a running Buiry server. Needs no credentials and changes nothing.
 *
 *   pnpm tsx scripts/smoke-deploy.ts https://buiry.example.com [--network testnet]
 *
 * Checks: health and network, HTTPS with an HTTP->HTTPS redirect, security headers, the dashboard, that the
 * authenticated REST and MCP surfaces refuse anonymous calls, and that oversized bodies are refused.
 */
const [base, ...rest] = process.argv.slice(2);
if (!base) {
  console.error('usage: smoke-deploy.ts <base-url> [--network testnet|mainnet]');
  process.exit(64);
}
const expectNetwork = rest.includes('--network') ? rest[rest.indexOf('--network') + 1] : undefined;
const url = base.replace(/\/+$/, '');
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    checks.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    checks.push({ name, ok: false, detail: (e as Error).message });
  }
};
const must = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

await check('health', async () => {
  const t0 = performance.now();
  const r = await fetch(`${url}/v1/healthz`);
  const ms = Math.round(performance.now() - t0);
  const j = (await r.json()) as { ok?: boolean; data?: { status?: string; network?: string } };
  must(r.ok && j.data?.status === 'ok', `HTTP ${r.status}`);
  if (expectNetwork) must(j.data?.network === expectNetwork, `network is ${j.data?.network ?? 'unknown'}`);
  return `ok in ${ms} ms, network ${j.data?.network ?? 'not reported'}`;
});

await check('https', async () => {
  must(url.startsWith('https://'), 'the base URL is not https');
  const r = await fetch(url.replace(/^https:/, 'http:') + '/v1/healthz', { redirect: 'manual' });
  must([301, 308].includes(r.status), `plain HTTP answered ${r.status}, not a redirect`);
  must((r.headers.get('location') ?? '').startsWith('https://'), 'redirect does not go to https');
  return `http redirects with ${r.status}`;
});

await check('security headers', async () => {
  const r = await fetch(`${url}/v1/healthz`);
  for (const h of ['x-content-type-options', 'referrer-policy']) must(!!r.headers.get(h), `missing ${h}`);
  return 'x-content-type-options, referrer-policy present';
});

await check('dashboard', async () => {
  const r = await fetch(`${url}/`);
  must(r.ok && (r.headers.get('content-type') ?? '').includes('text/html'), `HTTP ${r.status}`);
  return 'served';
});

await check('REST refuses anonymous calls', async () => {
  const r = await fetch(`${url}/v1/auth/me`);
  must(r.status === 401, `HTTP ${r.status}`);
  return '401';
});

await check('MCP refuses anonymous calls', async () => {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  must(r.status === 401, `HTTP ${r.status}`);
  return '401';
});

await check('oversized bodies are refused', async () => {
  const r = await fetch(`${url}/v1/auth/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x'.repeat(3 * 1024 * 1024) }),
  });
  must(r.status === 400 || r.status === 413, `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});

for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

export {};
