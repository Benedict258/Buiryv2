// SPDX-License-Identifier: Apache-2.0

export type RedactionAction = 'mask' | 'block';

export interface CustomPattern {
  name: string;
  /** Regular expression source. */
  pattern: string;
  flags?: string;
  action: RedactionAction;
}

export interface RedactionOptions {
  custom?: CustomPattern[];
  maskEmails?: boolean;
  maskPhones?: boolean;
}

export interface Finding {
  class: string;
  action: RedactionAction;
  start: number;
  end: number;
}

export interface RedactionResult {
  /** Text with every finding replaced by a [REDACTED:class] marker. */
  text: string;
  /** True when a block-class finding exists; the caller must refuse the write. */
  blocked: boolean;
  /** Distinct classes found, in first-seen order. */
  classes: string[];
  findings: Finding[];
}

interface Rule {
  cls: string;
  action: RedactionAction;
  re: RegExp;
  /** Capture group to replace; whole match when absent. */
  group?: number;
  accept?: (m: RegExpExecArray) => boolean;
}

const PLACEHOLDER_RE =
  /^(<.*>|\.{3,}|x{3,}|\*{3,}|\$\{.*\}|\$[A-Z_]+|your[_-].*|example.*|changeme|process\.env.*)$/i;

function looksLikeSecretValue(v: string): boolean {
  if (PLACEHOLDER_RE.test(v)) return false;
  if (/^(true|false|null|undefined|none|string|required|optional)$/i.test(v)) return false;
  if (/[0-9]/.test(v) || /[^A-Za-z]/.test(v)) return true;
  return v.length >= 20;
}

const SECRET_KEY_WORDS =
  '(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|private[_-]?key|access[_-]?key|auth)';

const CONTEXT_KEYS = /(private\s*key|priv\s*key|secret\s*key|signing\s*key|keystore|secret)\W{0,12}$/i;
const MNEMONIC_CONTEXT =
  /(mnemonic|seed\s*phrase|recovery\s*phrase|secret\s*phrase|backup\s*phrase|wallet\s*phrase|seed\s*words?)[^a-z0-9]{0,12}$/i;

const RULES: Rule[] = [
  // Block classes
  {
    cls: 'private_key_block',
    action: 'block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { cls: 'sui_private_key', action: 'block', re: /\bsuiprivkey1[02-9ac-hj-np-z]{40,80}\b/g },
  // Credentials and tokens
  { cls: 'aws_access_key', action: 'mask', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    cls: 'github_token',
    action: 'mask',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  { cls: 'slack_token', action: 'mask', re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g },
  { cls: 'stripe_key', action: 'mask', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { cls: 'google_api_key', action: 'mask', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { cls: 'buiry_token', action: 'mask', re: /\bbry_(?:at|pat)_[A-Za-z0-9_-]{16,}\b/g },
  { cls: 'jwt', action: 'mask', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    cls: 'auth_header',
    action: 'mask',
    re: /\b(?:authorization|proxy-authorization)\s*:\s*((?:bearer|basic|token)\s+)?([^\s,;]{6,})/gi,
    group: 2,
  },
  { cls: 'bearer_token', action: 'mask', re: /\bbearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1 },
  { cls: 'cookie_header', action: 'mask', re: /\b(?:set-cookie|cookie)\s*:\s*([^\n]{6,})/gi, group: 1 },
  {
    cls: 'api_key_header',
    action: 'mask',
    re: /\bx-[a-z-]*(?:api-key|auth-token|secret)\s*:\s*([^\s,;]{6,})/gi,
    group: 1,
  },
  { cls: 'url_credentials', action: 'mask', re: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s/@]+)@/gi, group: 1 },
  {
    cls: 'credential_assignment',
    action: 'mask',
    re: new RegExp(
      `\\b[A-Za-z0-9_.-]*${SECRET_KEY_WORDS}[A-Za-z0-9_.-]*\\s*[:=]\\s*["']?([^\\s"',;]{6,})`,
      'gi',
    ),
    group: 1,
    accept: (m) => looksLikeSecretValue(m[1] ?? ''),
  },
  // Keyed hex/base64 private keys (only with context, so object IDs and digests are untouched)
  {
    cls: 'private_key_hex',
    action: 'block',
    re: /(?:0x)?[0-9a-fA-F]{64}\b/g,
    accept: (m) => CONTEXT_KEYS.test(m.input.slice(Math.max(0, m.index - 40), m.index)),
  },
  // Personal data
  {
    cls: 'email',
    action: 'mask',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    // Not the userinfo part of a URL: that is handled by url_credentials and must keep the host.
    accept: (m) =>
      !/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i.test(m.input.slice(Math.max(0, m.index - 200), m.index)),
  },
  {
    cls: 'phone',
    action: 'mask',
    re: /(?<![\w.])(?:\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}|\(\d{3}\)\s?\d{3}[ .-]\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4})(?![\w.])/g,
  },
];

const WORD_RUN_RE = /(?:\b[a-z]{3,8}\b[ ]){11,23}\b[a-z]{3,8}\b/g;

function mnemonicFindings(text: string): Finding[] {
  const out: Finding[] = [];
  WORD_RUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RUN_RE.exec(text))) {
    const words = m[0].split(' ').length;
    if (![12, 15, 18, 21, 24].includes(words)) continue;
    if (MNEMONIC_CONTEXT.test(text.slice(Math.max(0, m.index - 30), m.index))) {
      out.push({ class: 'mnemonic', action: 'block', start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

export function scan(text: string, opts: RedactionOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const maskEmails = opts.maskEmails ?? true;
  const maskPhones = opts.maskPhones ?? true;
  for (const rule of RULES) {
    if (rule.cls === 'email' && !maskEmails) continue;
    if (rule.cls === 'phone' && !maskPhones) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      if (rule.accept && !rule.accept(m)) continue;
      let start = m.index;
      let end = m.index + m[0].length;
      if (rule.group !== undefined && m[rule.group] !== undefined) {
        const g = m[rule.group]!;
        const off = m[0].lastIndexOf(g);
        start = m.index + off;
        end = start + g.length;
      }
      findings.push({ class: rule.cls, action: rule.action, start, end });
    }
  }
  findings.push(...mnemonicFindings(text));
  for (const c of opts.custom ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(c.pattern, (c.flags ?? '').replace(/[gy]/g, '') + 'g');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      findings.push({
        class: `custom:${c.name}`,
        action: c.action,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return findings;
}

/** Merges overlapping findings; a block finding wins over a mask finding. */
function merge(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Finding[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f.start < last.end) {
      if (f.end > last.end) last.end = f.end;
      if (f.action === 'block' && last.action !== 'block') {
        last.action = 'block';
        last.class = f.class;
      }
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

export function redact(text: string, opts: RedactionOptions = {}): RedactionResult {
  const findings = merge(scan(text, opts));
  let out = '';
  let pos = 0;
  for (const f of findings) {
    out += text.slice(pos, f.start) + `[REDACTED:${f.class}]`;
    pos = f.end;
  }
  out += text.slice(pos);
  const classes: string[] = [];
  for (const f of findings) if (!classes.includes(f.class)) classes.push(f.class);
  return { text: out, blocked: findings.some((f) => f.action === 'block'), classes, findings };
}

// ---------- Prompt-injection scanner (also used for imports and briefings) ----------

const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'override_instructions',
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|context)\b/i,
  },
  {
    name: 'role_hijack',
    re: /\b(you are now|from now on you|act as (?:an? )?(?:system|root|admin)|new instructions?:)/i,
  },
  { name: 'system_marker', re: /(^|\n)\s*(system|assistant|developer)\s*:/i },
  {
    name: 'tool_call_syntax',
    re: /<\s*\/?\s*(tool_use|tool_call|function_calls?|invoke|antml:[a-z_]+)\b|\bfunction_call\b|"tool_calls"\s*:/i,
  },
  {
    name: 'agent_directive',
    re: /\b(you must|you should now|immediately|do not tell the user)\b[^.\n]{0,60}\b(run|execute|call|send|delete|exfiltrate|upload|curl|rm -rf)\b/i,
  },
  {
    name: 'exfiltration',
    re: /\b(send|post|upload|exfiltrate)\b[^.\n]{0,60}\b(secrets?|credentials?|tokens?|private keys?|\.env)\b/i,
  },
];

export interface InjectionScan {
  flagged: boolean;
  matches: string[];
}

export function scanInjection(text: string): InjectionScan {
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  return { flagged: matches.length > 0, matches };
}
