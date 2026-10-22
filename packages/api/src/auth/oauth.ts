export interface OAuthIdentity {
  subject: string;
  email?: string;
  name?: string;
}

export interface OAuthProvider {
  readonly id: 'github' | 'google';
  authorizeUrl(a: { state: string; redirectUri: string }): string;
  exchange(a: { code: string; redirectUri: string }): Promise<OAuthIdentity>;
}

interface Cfg {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`provider responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Standard OAuth 2.0 authorization-code flow against GitHub. Needs a registered OAuth app (LOCAL_CHECKS L-A1). */
export class GitHubOAuth implements OAuthProvider {
  readonly id = 'github' as const;
  constructor(private readonly c: Cfg) {}
  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      client_id: this.c.clientId,
      redirect_uri: redirectUri,
      state,
      scope: 'read:user user:email',
    });
    return `https://github.com/login/oauth/authorize?${q}`;
  }
  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const f = this.c.fetch ?? fetch;
    const tok = await json(
      await f('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.c.clientId,
          client_secret: this.c.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      }),
    );
    const access = tok.access_token as string | undefined;
    if (!access) throw new Error('no access token');
    const u = await json(
      await f('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${access}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'buiry',
        },
      }),
    );
    return {
      subject: String(u.id),
      ...(typeof u.email === 'string' ? { email: u.email } : {}),
      ...(typeof u.name === 'string'
        ? { name: u.name }
        : typeof u.login === 'string'
          ? { name: u.login }
          : {}),
    };
  }
}

/** Google OpenID Connect authorization-code flow. */
export class GoogleOAuth implements OAuthProvider {
  readonly id = 'google' as const;
  constructor(private readonly c: Cfg) {}
  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      client_id: this.c.clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: 'openid email profile',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const f = this.c.fetch ?? fetch;
    const tok = await json(
      await f('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.c.clientId,
          client_secret: this.c.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      }),
    );
    const access = tok.access_token as string | undefined;
    if (!access) throw new Error('no access token');
    const u = await json(
      await f('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${access}` },
      }),
    );
    return {
      subject: String(u.sub),
      ...(typeof u.email === 'string' && u.email_verified !== false ? { email: u.email } : {}),
      ...(typeof u.name === 'string' ? { name: u.name } : {}),
    };
  }
}

/** Test double: `code` is `ok:<subject>[:<email>]`. */
export class FakeOAuth implements OAuthProvider {
  constructor(readonly id: 'github' | 'google') {}
  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    return `https://fake.example/${this.id}?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchange({ code }: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const [ok, subject, email] = code.split(':');
    if (ok !== 'ok' || !subject) throw new Error('bad code');
    return { subject, ...(email ? { email } : {}), name: `fake-${subject}` };
  }
}
