import { setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { BuiryError } from '@buiry/core';
import {
  acceptInvitation,
  changeRole,
  createInvitation,
  listMembers,
  removeMember,
} from '../service/members.js';
import {
  SESSION_COOKIE,
  body,
  ok,
  parse,
  userCaller,
  workspacePrincipal,
  type Registrar,
} from './context.js';
import type { Context } from 'hono';
import type { AppContext } from './context.js';

function startSession(ctx: AppContext, c: Context, s: { token: string; expiresAt: Date }) {
  setCookie(c, SESSION_COOKIE, s.token, {
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    expires: s.expiresAt,
  });
}

export const registerAuth: Registrar = (_app, ctx, r) => {
  r({ method: 'GET', path: '/v1/healthz', auth: 'public', scope: 'none' }, (c) => ok(c, { status: 'ok' }));

  r({ method: 'POST', path: '/v1/auth/wallet/challenge', auth: 'public', scope: 'none' }, async (c) =>
    ok(c, await ctx.auth.walletChallenge()),
  );
  r({ method: 'POST', path: '/v1/auth/wallet/verify', auth: 'public', scope: 'none' }, async (c) => {
    const b = parse(
      z.object({ nonce: z.string(), address: z.string(), signature: z.string() }),
      await body(c),
    );
    const { session, newUser } = await ctx.auth.walletVerify(b, c.req.header('user-agent'));
    startSession(ctx, c, session);
    return ok(c, { session: { token: session.token, expiresAt: session.expiresAt }, newUser });
  });

  r({ method: 'GET', path: '/v1/auth/oauth/:provider/start', auth: 'public', scope: 'none' }, async (c) => {
    const { url } = await ctx.auth.oauthStart(c.req.param('provider')!);
    return c.redirect(url, 302);
  });
  r(
    { method: 'GET', path: '/v1/auth/oauth/:provider/callback', auth: 'public', scope: 'none' },
    async (c) => {
      const code = c.req.query('code');
      const state = c.req.query('state');
      if (!code || !state) throw new BuiryError('invalid_input', 'missing code or state');
      const { session, newUser } = await ctx.auth.oauthCallback(
        c.req.param('provider')!,
        code,
        state,
        c.req.header('user-agent'),
      );
      startSession(ctx, c, session);
      return ok(c, { session: { token: session.token, expiresAt: session.expiresAt }, newUser });
    },
  );

  r({ method: 'POST', path: '/v1/auth/email/start', auth: 'public', scope: 'none' }, async (c) => {
    await ctx.auth.emailStart(parse(z.object({ email: z.string() }), await body(c)).email);
    return ok(c, { sent: true }); // same answer whether or not the address is known
  });
  r({ method: 'POST', path: '/v1/auth/email/verify', auth: 'public', scope: 'none' }, async (c) => {
    const { session, newUser } = await ctx.auth.emailVerify(
      parse(z.object({ token: z.string() }), await body(c)).token,
      c.req.header('user-agent'),
    );
    startSession(ctx, c, session);
    return ok(c, { session: { token: session.token, expiresAt: session.expiresAt }, newUser });
  });

  r({ method: 'GET', path: '/v1/auth/me', auth: 'user', scope: 'self' }, async (c) => {
    const who = await userCaller(ctx, c);
    if (who.type !== 'session') throw new BuiryError('forbidden', 'this endpoint needs a signed-in user');
    return ok(c, await ctx.auth.me(who.userId));
  });
  r({ method: 'GET', path: '/v1/auth/sessions', auth: 'user', scope: 'session' }, async (c) => {
    const who = await userCaller(ctx, c);
    if (who.type !== 'session') throw new BuiryError('forbidden', 'this endpoint needs a signed-in user');
    return ok(
      c,
      (await ctx.auth.listSessions(who.userId)).map((s) => ({ ...s, current: s.id === who.sessionId })),
    );
  });
  r({ method: 'POST', path: '/v1/auth/logout', auth: 'user', scope: 'session' }, async (c) => {
    const who = await userCaller(ctx, c);
    if (who.type !== 'session') throw new BuiryError('forbidden', 'this endpoint needs a signed-in user');
    await ctx.auth.revokeSession(who.sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return ok(c, { signedOut: true });
  });
  r({ method: 'POST', path: '/v1/auth/logout-all', auth: 'user', scope: 'session' }, async (c) => {
    const who = await userCaller(ctx, c);
    if (who.type !== 'session') throw new BuiryError('forbidden', 'this endpoint needs a signed-in user');
    const n = await ctx.auth.signOutEverywhere(who.userId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return ok(c, { revoked: n });
  });

  // ---- team ----
  r({ method: 'GET', path: '/v1/workspaces/:ws/members', auth: 'user', scope: 'workspace' }, async (c) => {
    const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
    return ok(c, await ctx.deps.db.tenant(p.workspaceId, (tx) => listMembers(tx, p)));
  });
  r(
    { method: 'PATCH', path: '/v1/workspaces/:ws/members/:uid', auth: 'user', scope: 'workspace' },
    async (c) => {
      const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
      const { role } = parse(z.object({ role: z.enum(['admin', 'writer', 'reader']) }), await body(c));
      await ctx.deps.db.tenant(p.workspaceId, (tx) => changeRole(ctx.deps, tx, p, c.req.param('uid')!, role));
      return ok(c, { updated: true });
    },
  );
  r(
    { method: 'DELETE', path: '/v1/workspaces/:ws/members/:uid', auth: 'user', scope: 'workspace' },
    async (c) => {
      const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
      await ctx.deps.db.tenant(p.workspaceId, (tx) => removeMember(ctx.deps, tx, p, c.req.param('uid')!));
      return ok(c, { removed: true });
    },
  );
  r(
    { method: 'POST', path: '/v1/workspaces/:ws/invitations', auth: 'user', scope: 'workspace' },
    async (c) => {
      const p = await workspacePrincipal(ctx, await userCaller(ctx, c), c.req.param('ws')!);
      const b = parse(
        z.object({
          invitee: z.string().min(3),
          role: z.enum(['admin', 'writer', 'reader']),
          expiresInHours: z.number().int().min(1).max(720).optional(),
        }),
        await body(c),
      );
      return ok(
        c,
        await ctx.deps.db.tenant(p.workspaceId, (tx) => createInvitation(ctx.deps, tx, p, b)),
        201,
      );
    },
  );
  r({ method: 'POST', path: '/v1/invitations/accept', auth: 'user', scope: 'self' }, async (c) => {
    const who = await userCaller(ctx, c);
    if (who.type !== 'session') throw new BuiryError('forbidden', 'sign in to accept an invitation');
    const { token } = parse(z.object({ token: z.string() }), await body(c));
    return ok(c, await acceptInvitation(ctx.deps, token, who.userId));
  });
};
