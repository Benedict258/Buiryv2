import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createStack,
  createWebhook,
  deliverDue,
  isPrivateAddress,
  publishEvent,
  type UserPrincipal,
} from '../src/index.js';

// SECURITY_REVIEW M2: a webhook host is resolved and checked once, and the request goes to exactly that address. A
// resolver that changes its answer after the check (DNS rebinding) cannot redirect the request to an internal host.

async function world() {
  const s = await createStack({});
  const ws = await s.newWorkspace('Hooks Co');
  const prj = await s.newProject(ws.id, 'hooks');
  const admin: UserPrincipal = {
    kind: 'user',
    workspaceId: ws.id,
    userId: 'usr_admin',
    displayName: 'admin',
    role: 'owner',
    projectScope: null,
  };
  const hook = (url: string, opts: Parameters<typeof createWebhook>[4]) =>
    s.db.tenant(ws.id, (tx) =>
      createWebhook(
        s.deps,
        tx,
        admin,
        { name: 'h', kind: 'generic', url, events: ['*'], projectId: prj.id },
        opts,
      ),
    );
  const event = () =>
    s.db.tenant(ws.id, (tx) =>
      publishEvent(s.deps, tx, {
        workspaceId: ws.id,
        projectId: prj.id,
        type: 'flag.created',
        data: { detail: 'probe' },
      }),
    );
  return { s, hook, event };
}

describe('webhook delivery is pinned to the checked address', () => {
  it('sends to the address it checked even when DNS answers differently afterwards', async () => {
    const { s, hook, event } = await world();
    let lookups = 0;
    // First answer public, every later answer internal: a rebinding resolver.
    const rebinding = async () => (++lookups === 1 ? ['93.184.216.34'] : ['10.0.0.5']);
    await hook('https://hooks.example.com/x', { resolve: async () => ['93.184.216.34'] });
    await event();
    const sent: string[] = [];
    const rep = await deliverDue(s.deps, {
      resolve: rebinding,
      send: async (r) => {
        sent.push(r.address);
        return 200;
      },
    });
    expect(rep.delivered).toBe(1);
    expect(sent).toEqual(['93.184.216.34']);
    expect(lookups).toBe(1); // resolved once per delivery; the connection does not look it up again
    await s.close();
  });

  it('the default sender connects to the checked address without a second DNS lookup', async () => {
    const got: string[] = [];
    const receiver = createServer((req, res) => {
      got.push(`${req.method} ${req.url} host=${req.headers.host}`);
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const port = (receiver.address() as { port: number }).port;
    const { s, hook, event } = await world();
    // The host name does not exist in DNS; only the checked answer (127.0.0.1) can reach the receiver.
    const url = `http://pinned.invalid:${port}/hook`;
    const opts = { allowHttp: true, allowPrivate: true, resolve: async () => ['127.0.0.1'] };
    await hook(url, opts);
    await event();
    const rep = await deliverDue(s.deps, opts);
    expect(rep.delivered).toBe(1);
    expect(got).toEqual([`POST /hook host=pinned.invalid:${port}`]);
    await new Promise((r) => receiver.close(r));
    await s.close();
  });

  it('treats NAT64, 6to4 and benchmarking ranges as internal', () => {
    for (const ip of [
      '198.18.0.1',
      '198.19.255.254',
      '192.0.0.8',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
      '::ffff:7f00:1',
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['93.184.216.34', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
});
