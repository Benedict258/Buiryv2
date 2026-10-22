import { randomBytes } from 'node:crypto';
import { BuiryError } from '@buiry/core';
import type { Db } from '../db/db.js';
import type { ServiceDeps, UserPrincipal, Role } from '../service/types.js';
import { genId, hmac } from '../service/util.js';
import type { OAuthProvider } from './oauth.js';
import { signInMessage, type WalletVerifier } from './wallet.js';

export interface Mailer {
  sendMagicLink(to: string, link: string): Promise<void>;
}

/** Test/dev double that records links instead of sending them. */
export class MemoryMailer implements Mailer {
  sent: { to: string; link: string }[] = [];
  async sendMagicLink(to: string, link: string): Promise<void> {
    this.sent.push({ to, link });
  }
}

export interface AuthConfig {
  /** Domain shown in wallet sign-in messages. */
  domain: string;
  baseUrl: string;
  sessionTtlMs?: number;
  challengeTtlMs?: number;
  magicLinkTtlMs?: number;
  wallet: WalletVerifier;
  providers: Partial<Record<'github' | 'google', OAuthProvider>>;
  mailer: Mailer;
}

export interface SessionInfo {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export interface UserSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  identities: { provider: string; subject: string }[];
  workspaces: { id: string; name: string; role: Role; plan: string }[];
}

const SESSION_PREFIX = 'bry_ses_';

export class AuthService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly cfg: AuthConfig,
  ) {}

  private get db(): Db {
    return this.deps.db;
  }

  // ---------- users and sessions ----------

  /** Finds or creates the user for an identity. A new user gets a personal workspace they own. */
  async signIn(
    provider: 'wallet' | 'google' | 'github' | 'email',
    subject: string,
    profile: { email?: string; name?: string } = {},
    userAgent?: string,
  ): Promise<{ session: SessionInfo; newUser: boolean }> {
    const now = new Date(this.deps.now());
    const { userId, newUser } = await this.db.system(async (tx) => {
      const ident = await tx.query<{ user_id: string }>(
        'select user_id from identities where provider = $1 and subject = $2',
        [provider, subject],
      );
      if (ident.rows[0]) return { userId: ident.rows[0].user_id, newUser: false };
      // Email sign-ins link to an existing account with the same verified email; wallets and OAuth ids never merge silently.
      let uid: string | undefined;
      if (profile.email && (provider === 'email' || provider === 'google')) {
        uid = (
          await tx.query<{ id: string }>('select id from users where email = $1', [
            profile.email.toLowerCase(),
          ])
        ).rows[0]?.id;
      }
      let created = false;
      if (!uid) {
        uid = genId(this.deps, 'usr');
        created = true;
        // An email already owned by another account is not stored again (emails are unique); the identity still signs in.
        const taken = profile.email
          ? (await tx.query('select 1 from users where email = $1', [profile.email.toLowerCase()])).rows
              .length > 0
          : false;
        await tx.query('insert into users (id, email, display_name, created_at) values ($1,$2,$3,$4)', [
          uid,
          profile.email && !taken ? profile.email.toLowerCase() : null,
          profile.name ?? null,
          now,
        ]);
        const wid = genId(this.deps, 'wsp');
        const label = profile.name ?? profile.email?.split('@')[0] ?? `${subject.slice(0, 8)}`;
        await tx.query('insert into workspaces (id, name) values ($1,$2)', [wid, `${label}'s workspace`]);
        await tx.query(`insert into memberships (workspace_id, user_id, role) values ($1,$2,'owner')`, [
          wid,
          uid,
        ]);
      }
      await tx.query('insert into identities (id, user_id, provider, subject) values ($1,$2,$3,$4)', [
        genId(this.deps, 'evt'),
        uid,
        provider,
        subject,
      ]);
      return { userId: uid, newUser: created };
    });
    return { session: await this.createSession(userId, userAgent), newUser };
  }

  async createSession(userId: string, userAgent?: string): Promise<SessionInfo> {
    const token = SESSION_PREFIX + randomBytes(32).toString('base64url');
    const id = genId(this.deps, 'evt');
    const expiresAt = new Date(this.deps.now() + (this.cfg.sessionTtlMs ?? 30 * 86_400_000));
    await this.db.system((tx) =>
      tx.query(
        'insert into sessions (id, user_id, token_hash, user_agent, created_at, expires_at) values ($1,$2,$3,$4,$5,$6)',
        [
          id,
          userId,
          hmac(this.deps.secretKey, token),
          userAgent ?? null,
          new Date(this.deps.now()),
          expiresAt,
        ],
      ),
    );
    return { id, userId, token, expiresAt };
  }

  async resolveSession(token: string): Promise<{ userId: string; sessionId: string } | null> {
    if (!token.startsWith(SESSION_PREFIX)) return null;
    const r = await this.db.system((tx) =>
      tx.query<{ id: string; user_id: string }>(
        'select id, user_id from sessions where token_hash = $1 and revoked_at is null and expires_at > $2',
        [hmac(this.deps.secretKey, token), new Date(this.deps.now())],
      ),
    );
    return r.rows[0] ? { userId: r.rows[0].user_id, sessionId: r.rows[0].id } : null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.system((tx) =>
      tx.query('update sessions set revoked_at = $1 where id = $2', [new Date(this.deps.now()), sessionId]),
    );
  }

  async signOutEverywhere(userId: string): Promise<number> {
    const r = await this.db.system((tx) =>
      tx.query('update sessions set revoked_at = $1 where user_id = $2 and revoked_at is null returning id', [
        new Date(this.deps.now()),
        userId,
      ]),
    );
    return r.rows.length;
  }

  async listSessions(userId: string) {
    const r = await this.db.system((tx) =>
      tx.query<{ id: string; user_agent: string | null; created_at: Date; expires_at: Date }>(
        'select id, user_agent, created_at, expires_at from sessions where user_id = $1 and revoked_at is null and expires_at > $2 order by created_at desc',
        [userId, new Date(this.deps.now())],
      ),
    );
    return r.rows;
  }

  // ---------- wallet ----------

  async walletChallenge(): Promise<{ nonce: string; message: string; expiresAt: string }> {
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(this.deps.now() + (this.cfg.challengeTtlMs ?? 5 * 60_000));
    await this.db.system((tx) =>
      tx.query(
        `insert into auth_challenges (nonce, purpose, domain, expires_at) values ($1,'wallet',$2,$3)`,
        [nonce, this.cfg.domain, expiresAt],
      ),
    );
    return {
      nonce,
      message: signInMessage({ domain: this.cfg.domain, nonce, expiresAt }),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async walletVerify(a: { nonce: string; address: string; signature: string }, userAgent?: string) {
    const ch = await this.db.system(async (tx) => {
      const r = await tx.query<{ nonce: string; domain: string; expires_at: Date; used_at: Date | null }>(
        `update auth_challenges set used_at = $2 where nonce = $1 and purpose = 'wallet' and used_at is null returning nonce, domain, expires_at, used_at`,
        [a.nonce, new Date(this.deps.now())],
      );
      return r.rows[0];
    });
    // The nonce is consumed on the first attempt, valid or not (single use).
    if (!ch || new Date(ch.expires_at).getTime() < this.deps.now())
      throw new BuiryError('unauthorized', 'sign-in challenge is invalid or expired');
    const message = signInMessage({ domain: ch.domain, nonce: ch.nonce, expiresAt: new Date(ch.expires_at) });
    if (!(await this.cfg.wallet.verify({ message, signature: a.signature, address: a.address })))
      throw new BuiryError('unauthorized', 'wallet signature did not verify');
    return this.signIn('wallet', a.address.toLowerCase(), {}, userAgent);
  }

  // ---------- OAuth ----------

  private provider(id: string): OAuthProvider {
    const p = this.cfg.providers[id as 'github' | 'google'];
    if (!p) throw new BuiryError('not_found', `sign-in with ${id} is not configured`);
    return p;
  }

  async oauthStart(provider: string): Promise<{ url: string; state: string }> {
    const p = this.provider(provider);
    const state = randomBytes(16).toString('hex');
    await this.db.system((tx) =>
      tx.query(
        `insert into auth_challenges (nonce, purpose, subject, domain, expires_at) values ($1,'oauth',$2,$3,$4)`,
        [state, provider, this.cfg.domain, new Date(this.deps.now() + 10 * 60_000)],
      ),
    );
    return {
      url: p.authorizeUrl({ state, redirectUri: `${this.cfg.baseUrl}/v1/auth/oauth/${provider}/callback` }),
      state,
    };
  }

  async oauthCallback(provider: string, code: string, state: string, userAgent?: string) {
    const p = this.provider(provider);
    const ok = await this.db.system(
      async (tx) =>
        (
          await tx.query(
            `update auth_challenges set used_at = $3 where nonce = $1 and purpose = 'oauth' and subject = $2 and used_at is null and expires_at > $3 returning nonce`,
            [state, provider, new Date(this.deps.now())],
          )
        ).rows.length > 0,
    );
    if (!ok) throw new BuiryError('unauthorized', 'sign-in state is invalid or expired');
    let id;
    try {
      id = await p.exchange({ code, redirectUri: `${this.cfg.baseUrl}/v1/auth/oauth/${provider}/callback` });
    } catch {
      throw new BuiryError('unauthorized', `${provider} did not accept the sign-in`);
    }
    return this.signIn(
      provider as 'github' | 'google',
      id.subject,
      { ...(id.email ? { email: id.email } : {}), ...(id.name ? { name: id.name } : {}) },
      userAgent,
    );
  }

  // ---------- email link ----------

  async emailStart(email: string): Promise<void> {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      throw new BuiryError('invalid_input', 'enter a valid email address');
    const recent = await this.db.system((tx) =>
      tx.query<{ n: string }>(`select count(*) as n from magic_links where email = $1 and expires_at > $2`, [
        e,
        new Date(this.deps.now() - 3_600_000 + (this.cfg.magicLinkTtlMs ?? 15 * 60_000)),
      ]),
    );
    if (Number(recent.rows[0]!.n) >= 5)
      throw new BuiryError('rate_limited', 'too many sign-in links requested; try again later', 600_000);
    const token = randomBytes(24).toString('base64url');
    await this.db.system((tx) =>
      tx.query('insert into magic_links (token_hash, email, expires_at) values ($1,$2,$3)', [
        hmac(this.deps.secretKey, token),
        e,
        new Date(this.deps.now() + (this.cfg.magicLinkTtlMs ?? 15 * 60_000)),
      ]),
    );
    await this.cfg.mailer.sendMagicLink(e, `${this.cfg.baseUrl}/auth/email?token=${token}`);
  }

  async emailVerify(token: string, userAgent?: string) {
    const r = await this.db.system((tx) =>
      tx.query<{ email: string }>(
        'update magic_links set used_at = $2 where token_hash = $1 and used_at is null and expires_at > $2 returning email',
        [hmac(this.deps.secretKey, token), new Date(this.deps.now())],
      ),
    );
    if (!r.rows[0]) throw new BuiryError('unauthorized', 'this sign-in link is invalid, used or expired');
    return this.signIn('email', r.rows[0].email, { email: r.rows[0].email }, userAgent);
  }

  // ---------- principals ----------

  async me(userId: string): Promise<UserSummary> {
    return this.db.system(async (tx) => {
      const u = await tx.query<{ id: string; email: string | null; display_name: string | null }>(
        'select id, email, display_name from users where id = $1',
        [userId],
      );
      if (!u.rows[0]) throw new BuiryError('unauthorized', 'unknown user');
      const ids = await tx.query<{ provider: string; subject: string }>(
        'select provider, subject from identities where user_id = $1',
        [userId],
      );
      const ws = await tx.query<{ id: string; name: string; role: Role; plan: string }>(
        'select w.id, w.name, m.role, w.plan from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = $1 order by w.created_at',
        [userId],
      );
      return {
        id: u.rows[0].id,
        email: u.rows[0].email,
        displayName: u.rows[0].display_name,
        identities: ids.rows,
        workspaces: ws.rows,
      };
    });
  }

  /** Membership lookup: returns null (not an error) for non-members so callers can answer 404. */
  async principalFor(userId: string, workspaceId: string): Promise<UserPrincipal | null> {
    const r = await this.db.system((tx) =>
      tx.query<{
        role: Role;
        project_scope: string[] | null;
        display_name: string | null;
        email: string | null;
      }>(
        'select m.role, m.project_scope, u.display_name, u.email from memberships m join users u on u.id = m.user_id where m.user_id = $1 and m.workspace_id = $2',
        [userId, workspaceId],
      ),
    );
    const m = r.rows[0];
    return m
      ? {
          kind: 'user',
          workspaceId,
          userId,
          displayName: m.display_name ?? m.email ?? userId,
          role: m.role,
          projectScope: m.project_scope,
        }
      : null;
  }
}
