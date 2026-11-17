import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BuiryError } from '@buiry/core';
import { SmtpMailer, smtpConfigFromEnv, type SmtpConfig } from '../src/index.js';
import { mailerFromEnv } from '../src/server.js';

// Phase 7: the SMTP mailer against an in-process fake SMTP server (plain SMTP, AUTH PLAIN, no STARTTLS).

interface FakeOpts {
  rejectRcpt?: boolean;
}
class FakeSmtp {
  server!: Server;
  port = 0;
  transcript: string[] = [];
  messages: { from: string; to: string[]; data: string }[] = [];
  opts: FakeOpts = {};

  async start() {
    this.server = createServer((sock) => this.session(sock));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
  }

  private session(sock: Socket) {
    let buf = '';
    let inData = false;
    let cur = { from: '', to: [] as string[], data: '' };
    const say = (l: string) => sock.write(l + '\r\n');
    say('220 fake.smtp.test ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        this.transcript.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            this.messages.push(cur);
            cur = { from: '', to: [], data: '' };
            say('250 2.0.0 queued');
          } else cur.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') {
          say('250-fake.smtp.test');
          say('250-AUTH PLAIN LOGIN');
          say('250 8BITMIME');
        } else if (cmd === 'HELO') say('250 fake.smtp.test');
        else if (cmd === 'AUTH') say('235 2.7.0 authenticated');
        else if (cmd === 'MAIL') {
          cur.from = line;
          say('250 2.1.0 ok');
        } else if (cmd === 'RCPT') {
          if (this.opts.rejectRcpt) say('550 5.1.1 mailbox unavailable');
          else {
            cur.to.push(line);
            say('250 2.1.5 ok');
          }
        } else if (cmd === 'DATA') {
          inData = true;
          say('354 end with .');
        } else if (cmd === 'QUIT') {
          say('221 bye');
          sock.end();
        } else if (cmd === 'RSET' || cmd === 'NOOP') say('250 ok');
        else say('502 not implemented');
      }
    });
    sock.on('error', () => {});
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const fake = new FakeSmtp();
const LINK = 'https://app.buiry.test/auth/email?token=tok_SECRET_link_value_123';
const PASSWORD = 'smtp-password-not-real-xyz';
const logged: string[] = [];
const cfg = (o: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port: fake.port,
  secure: false,
  requireTLS: false,
  user: 'buiry',
  password: PASSWORD,
  from: 'Buiry <sign-in@buiry.test>',
  timeoutMs: 5000,
  ...o,
});

beforeAll(async () => {
  await fake.start();
  for (const k of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await fake.stop();
});
afterEach(() => {
  fake.opts = {};
});

describe('SMTP mailer', () => {
  it('delivers the sign-in link in the message body, authenticated, and logs nothing', async () => {
    const m = new SmtpMailer(cfg());
    await m.sendMagicLink('amara@example.invalid', LINK);
    m.close();
    const msg = fake.messages.at(-1)!;
    expect(msg.to.join()).toContain('amara@example.invalid');
    expect(msg.from).toContain('sign-in@buiry.test');
    expect(msg.data).toContain('Subject: Your Buiry sign-in link');
    expect(msg.data.replace(/=\r?\n/g, '')).toContain(LINK);
    expect(fake.transcript.some((l) => l.startsWith('AUTH'))).toBe(true);
    expect(logged.join('\n')).not.toContain('tok_SECRET');
    expect(logged.join('\n')).not.toContain(PASSWORD);
  });

  it('reports a refused recipient without echoing the link or the password', async () => {
    fake.opts.rejectRcpt = true;
    const m = new SmtpMailer(cfg());
    const e = await m.sendMagicLink('nobody@example.invalid', LINK).catch((x: Error) => x);
    m.close();
    expect(e).toBeInstanceOf(BuiryError);
    expect((e as Error).message).toContain('could not be sent');
    expect((e as Error).message).not.toContain('tok_SECRET');
    expect((e as Error).message).not.toContain(PASSWORD);
    expect(logged.join('\n')).not.toContain('tok_SECRET');
  });

  it('refuses to send in clear text when TLS is required and the server offers no STARTTLS', async () => {
    const before = fake.messages.length;
    const seen = fake.transcript.length;
    const m = new SmtpMailer(cfg({ requireTLS: true }));
    await expect(m.sendMagicLink('amara@example.invalid', LINK)).rejects.toThrow('could not be sent');
    m.close();
    expect(fake.messages.length).toBe(before);
    expect(fake.transcript.slice(seen).some((l) => l.includes('tok_SECRET'))).toBe(false);
  });
});

describe('SMTP configuration', () => {
  const base = {
    BUIRY_MAILER: 'smtp',
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_FROM: 'Buiry <a@example.invalid>',
  };

  it('requires TLS by default and always in production, and names variables, never values', () => {
    expect(smtpConfigFromEnv(base)).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(smtpConfigFromEnv({ ...base, SMTP_SECURE: 'true' })).toMatchObject({ port: 465, secure: true });
    expect(smtpConfigFromEnv({ ...base, SMTP_REQUIRE_TLS: '0' }).requireTLS).toBe(false);
    expect(() => smtpConfigFromEnv({ ...base, NODE_ENV: 'production', SMTP_REQUIRE_TLS: '0' })).toThrow(
      'refused in production',
    );
    expect(() => smtpConfigFromEnv({ BUIRY_MAILER: 'smtp' })).toThrow('SMTP_HOST and SMTP_FROM');
    let msg = '';
    try {
      smtpConfigFromEnv({ ...base, SMTP_USER: 'u' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('SMTP_USER and SMTP_PASSWORD must be set together');
  });

  it('is selected by BUIRY_MAILER=smtp, including in production', () => {
    const m = mailerFromEnv({ ...base, NODE_ENV: 'production' });
    expect(m).toBeInstanceOf(SmtpMailer);
    (m as SmtpMailer).close();
  });
});
