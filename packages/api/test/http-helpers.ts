/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateKeyPairSync } from 'node:crypto';
import { RestBackend } from '@buiry/mcp';
import {
  FakeOAuth,
  FakeWalletVerifier,
  MemoryMailer,
  SuiPersonalMessageVerifier,
  createApp,
  signPersonalMessageForTest,
  type BuiryApp,
} from '../src/index.js';
import { Clock, createStack, type Stack } from './helpers.js';

export const ORIGIN = 'https://app.buiry.test';

export interface World {
  stack: Stack;
  built: BuiryApp;
  clock: Clock;
  mailer: MemoryMailer;
  req: (
    method: string,
    path: string,
    o?: ReqOpts,
  ) => Promise<{ status: number; json: any; headers: Headers; res: Response }>;
  /** Signs in by email and returns a bearer session token. */
  signIn: (email: string) => Promise<{ token: string; userId: string; workspaceId: string }>;
  restBackend: (token: string) => RestBackend;
  close: () => Promise<void>;
}

export interface ReqOpts {
  token?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function makeWorld(
  o: { realWallet?: boolean; enforcePlans?: boolean; stackOpts?: Parameters<typeof createStack>[0] } = {},
): Promise<World> {
  const clock = new Clock();
  const stack = await createStack({ now: clock.now, ...(o.stackOpts ?? {}) });
  const mailer = new MemoryMailer();
  const built = createApp({
    deps: stack.deps,
    authRequestsPerMinute: 100000,
    auth: {
      domain: 'app.buiry.test',
      baseUrl: ORIGIN,
      wallet: o.realWallet ? new SuiPersonalMessageVerifier() : new FakeWalletVerifier(),
      providers: { github: new FakeOAuth('github'), google: new FakeOAuth('google') },
      mailer,
    },
    config: {
      allowedOrigins: [ORIGIN],
      cookieSecure: true,
      enforcePlans: o.enforcePlans ?? true,
      feedIntervalMs: 20,
      evidence: { walrusNetwork: 'mainnet', delegatePublicKey: 'aa'.repeat(32), tatumNetwork: 'mainnet' },
      webhook: { resolve: async () => ['93.184.216.34'] },
    },
  });
  const req: World['req'] = async (method, path, ro = {}) => {
    const headers: Record<string, string> = { ...(ro.headers ?? {}) };
    if (ro.token) headers.authorization = `Bearer ${ro.token}`;
    if (ro.cookie) headers.cookie = ro.cookie;
    if (ro.body !== undefined) headers['content-type'] = 'application/json';
    const res = await built.app.request(path, {
      method,
      headers,
      ...(ro.body !== undefined ? { body: JSON.stringify(ro.body) } : {}),
    });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers, res };
  };
  const signIn = async (email: string) => {
    await req('POST', '/v1/auth/email/start', { body: { email } });
    const link = mailer.sent.at(-1)!.link;
    const token = new URL(link).searchParams.get('token')!;
    const v = await req('POST', '/v1/auth/email/verify', { body: { token } });
    const me = await req('GET', '/v1/auth/me', { token: v.json.data.session.token });
    return {
      token: v.json.data.session.token as string,
      userId: me.json.data.id as string,
      workspaceId: me.json.data.workspaces[0].id as string,
    };
  };
  const restBackend = (token: string) =>
    new RestBackend({
      baseUrl: 'http://api.test',
      token,
      fetch: (async (url: string, init: RequestInit) =>
        built.app.request(new URL(url).pathname, init)) as unknown as typeof fetch,
    });
  return { stack, built, clock, mailer, req, signIn, restBackend, close: () => stack.close() };
}

export function walletKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return (message: string) => signPersonalMessageForTest(privateKey, message);
}
