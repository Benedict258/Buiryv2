import { createTransport, type SmtpTransportOptions, type Transporter } from 'nodemailer';
import { BuiryError } from '@buiry/core';
import type { Mailer } from './auth-service.js';

/** SMTP settings, read from SMTP_* environment variables. The password is never logged. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (usually port 465). */
  secure: boolean;
  /** Refuse to send unless the server upgrades with STARTTLS. Always true in production. */
  requireTLS: boolean;
  user?: string;
  password?: string;
  /** The From header, e.g. "Buiry <sign-in@example.com>". */
  from: string;
  timeoutMs: number;
}

/**
 * Reads SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_REQUIRE_TLS, SMTP_USER, SMTP_PASSWORD, SMTP_FROM and
 * SMTP_TIMEOUT_MS. Errors name variables only, never values.
 */
export function smtpConfigFromEnv(env: Record<string, string | undefined>): SmtpConfig {
  const missing = ['SMTP_HOST', 'SMTP_FROM'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`BUIRY_MAILER=smtp needs ${missing.join(' and ')}`);
  if (!!env.SMTP_USER !== !!env.SMTP_PASSWORD)
    throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
  const secure = env.SMTP_SECURE === '1' || env.SMTP_SECURE === 'true';
  const production = env.NODE_ENV === 'production';
  if (production && env.SMTP_REQUIRE_TLS === '0')
    throw new Error(
      'SMTP_REQUIRE_TLS=0 is refused in production: sign-in links must not travel in clear text',
    );
  return {
    host: env.SMTP_HOST!,
    port: Number(env.SMTP_PORT ?? (secure ? 465 : 587)),
    secure,
    requireTLS: !secure && (production || env.SMTP_REQUIRE_TLS !== '0'),
    ...(env.SMTP_USER ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD! } : {}),
    from: env.SMTP_FROM!,
    timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? 10_000),
  };
}

/**
 * Sends sign-in links over SMTP (nodemailer). The link is a bearer secret: it goes only into the message body, and
 * neither it nor the SMTP password reaches a log or an error message. nodemailer's own logger and debug output are
 * off, since they would print the message.
 */
export class SmtpMailer implements Mailer {
  private readonly t: Transporter;

  constructor(
    private readonly cfg: SmtpConfig,
    o: { tls?: SmtpTransportOptions['tls'] } = {},
  ) {
    this.t = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTLS,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.password! } } : {}),
      connectionTimeout: cfg.timeoutMs,
      greetingTimeout: cfg.timeoutMs,
      socketTimeout: cfg.timeoutMs,
      logger: false,
      debug: false,
      tls: { minVersion: 'TLSv1.2', ...o.tls },
    });
  }

  async sendMagicLink(to: string, link: string): Promise<void> {
    try {
      await this.t.sendMail({
        from: this.cfg.from,
        to,
        subject: 'Your Buiry sign-in link',
        text: [
          'Use this link to sign in to Buiry. It works once and expires in 15 minutes.',
          '',
          link,
          '',
          'If you did not ask to sign in, ignore this email.',
        ].join('\n'),
      });
    } catch (e) {
      // SMTP errors can echo parts of the conversation; report only the class of failure.
      const code =
        (e as { code?: string; responseCode?: number }).responseCode ?? (e as { code?: string }).code;
      throw new BuiryError(
        'internal',
        `the sign-in email could not be sent${code ? ` (${String(code)})` : ''}`,
      );
    }
  }

  close(): void {
    this.t.close();
  }
}
