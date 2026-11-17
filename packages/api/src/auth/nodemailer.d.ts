// The small part of nodemailer 10 that Buiry uses (the package ships no type declarations).
declare module 'nodemailer' {
  export interface SmtpTransportOptions {
    host: string;
    port: number;
    secure: boolean;
    requireTLS?: boolean;
    auth?: { user: string; pass: string };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
    logger?: boolean;
    debug?: boolean;
    tls?: { rejectUnauthorized?: boolean; minVersion?: string };
  }
  export interface MailMessage {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }
  export interface Transporter {
    sendMail(m: MailMessage): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[] }>;
    close(): void;
  }
  export function createTransport(o: SmtpTransportOptions): Transporter;
}
