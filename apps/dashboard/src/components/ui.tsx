import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock,
  Copy,
  FileText,
  Info,
  Link2,
  Lock,
  Loader2,
  Package,
  Box,
  ReceiptText,
  Search,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  Timer,
  X,
  XCircle,
  GitBranch,
  FlaskConical,
  Hourglass,
  Check,
} from 'lucide-react';
import { ago, band, evidenceLabel, exact, initials, typeLabel, until } from '../lib/format';
import { ApiError } from '../lib/api';
import { useApp, useKey } from '../lib/app';
import type { Evidence, MemType, Status } from '../lib/types';

const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(' ');
const sv = (v: string): CSSProperties => ({ ['--c' as string]: v });

/* ---------- buttons ---------- */
export function Button({
  variant = 'secondary',
  size,
  loading,
  icon,
  children,
  ...p
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm';
  loading?: boolean;
  icon?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cx('btn', variant === 'secondary' ? '' : variant, size, !children && 'icon', p.className)}
    >
      {loading ? <span className="spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost icon sm copy"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function CodeBlock({ children, value }: { children?: ReactNode; value: string }) {
  return (
    <div className="code">
      {children ?? value}
      <CopyButton value={value} />
    </div>
  );
}

export function IdBlock({ value, n = 10 }: { value: string; n?: number }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className="mono" title={value}>
        {value.length > n * 2 + 1 ? `${value.slice(0, n)}…${value.slice(-4)}` : value}
      </span>
      <CopyButton value={value} />
    </span>
  );
}

/* ---------- chips ---------- */
const STATUS_META: Record<Status | 'expired', { c: string; Icon: typeof Info; tip: string }> = {
  proposed: {
    c: 'var(--s-proposed)',
    Icon: Sparkles,
    tip: 'Written by an agent; not yet confirmed by a person',
  },
  confirmed: {
    c: 'var(--s-confirmed)',
    Icon: CheckCircle2,
    tip: 'Confirmed by a person or by enough independent evidence',
  },
  contested: {
    c: 'var(--s-contested)',
    Icon: AlertTriangle,
    tip: 'Conflicts with another memory or was reported wrong',
  },
  stale: { c: 'var(--s-stale)', Icon: XCircle, tip: 'Evidence no longer matches the current state' },
  superseded: { c: 'var(--s-superseded)', Icon: Archive, tip: 'Replaced by a newer memory' },
  tombstoned: { c: 'var(--s-tombstoned)', Icon: Ban, tip: 'Withdrawn from recall; stays in storage' },
  expired: { c: 'var(--s-expired)', Icon: Hourglass, tip: 'Stored period ended; no longer used' },
};
export function StatusChip({ status }: { status: Status | 'expired' }) {
  const m = STATUS_META[status];
  return (
    <span className="chip s" style={sv(m.c)} title={m.tip}>
      <m.Icon size={12} aria-hidden />
      {status}
    </span>
  );
}

const TYPE_ICON: Record<MemType, typeof Info> = {
  decision: GitBranch,
  constraint: Lock,
  fact: Info,
  failure: XCircle,
  procedure: ReceiptText,
  preference: Sparkles,
  task_state: Timer,
  deployment: Package,
  handoff: Link2,
};
export function TypeChip({ type }: { type: MemType }) {
  const I = TYPE_ICON[type] ?? Info;
  return (
    <span className="chip">
      <I size={12} aria-hidden />
      {typeLabel(type)}
    </span>
  );
}

export function ConfidenceMeter({
  value,
  large,
  decayed,
}: {
  value: number;
  large?: boolean;
  decayed?: boolean;
}) {
  const b = band(value);
  const c = b === 'low' ? 'var(--s-stale)' : b === 'medium' ? 'var(--s-contested)' : 'var(--s-confirmed)';
  return (
    <span
      className={cx('meter', large && 'lg')}
      style={sv(c)}
      title={`Confidence ${value.toFixed(2)} (${b})${decayed ? ', lowered by decay' : ''}`}
    >
      <span
        className="bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={value}
        aria-label="Confidence"
      >
        <i style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="mono">{value.toFixed(2)}</span>
      {decayed && (
        <span className="faint small" title="Decay lowered this score">
          ↓
        </span>
      )}
    </span>
  );
}

const EV_ICON: Record<string, typeof Info> = {
  tx: Box,
  object: Box,
  package: Package,
  file: FileText,
  url: Link2,
  test: FlaskConical,
};
export function EvidenceChip({ e, result, onClick }: { e: Evidence; result?: string; onClick?: () => void }) {
  const I = EV_ICON[e.kind] ?? Info;
  const R =
    result === 'pass'
      ? ShieldCheck
      : result === 'fail'
        ? ShieldX
        : result === 'checking'
          ? Loader2
          : ShieldQuestion;
  const col =
    result === 'pass' ? 'var(--s-verified)' : result === 'fail' ? 'var(--s-stale)' : 'var(--text-tertiary)';
  const word =
    result === 'pass'
      ? 'verified'
      : result === 'fail'
        ? 'failed'
        : result === 'checking'
          ? 'checking'
          : 'unknown';
  return (
    <button
      className="chip mono"
      style={{ cursor: onClick ? 'pointer' : 'default', background: 'none', ...sv(col) }}
      onClick={onClick}
      title={`${e.kind}: ${evidenceLabel(e)} (${word})`}
      aria-label={`${e.kind} evidence ${word}`}
    >
      <I size={12} aria-hidden />
      <span className="trunc" style={{ maxWidth: 140 }}>
        {evidenceLabel(e)}
      </span>
      <R size={12} style={{ color: col }} aria-hidden />
    </button>
  );
}

export function AgentBadge({ name, tool, status }: { name: string; tool?: string; status?: string }) {
  const user = name === 'user' || tool === 'user';
  return (
    <span
      className="row"
      style={{ gap: 6, minWidth: 0 }}
      title={`${name}${tool ? ` (${tool})` : ''}${status ? `, ${status}` : ''}`}
    >
      <span className="avatar" aria-hidden>
        {user ? initials(name) : <Bot size={13} />}
      </span>
      <span className={cx('small trunc', status === 'revoked' && 'struck')}>{name}</span>
    </span>
  );
}

export function BranchPill({ name, locked }: { name: string; locked?: boolean }) {
  return (
    <span className="pill mono" title={locked ? 'Protected branch' : 'Branch'}>
      <GitBranch size={12} aria-hidden />
      {name}
      {locked && <Lock size={11} aria-label="protected" />}
    </span>
  );
}

export function ExpiryIndicator({
  expiresAt,
  expired,
  marginDays = 28,
}: {
  expiresAt: string | null;
  expired?: boolean;
  marginDays?: number;
}) {
  if (expired) return <StatusChip status="expired" />;
  if (!expiresAt) return <span className="faint small">unknown</span>;
  const d = Math.round((Date.parse(expiresAt) - Date.now()) / 86_400_000);
  const near = d <= marginDays;
  return (
    <span
      className="small row"
      style={{ gap: 4, color: near ? 'var(--s-contested)' : 'var(--text-secondary)' }}
      title={`Expires ${exact(expiresAt)}`}
    >
      <Clock size={12} aria-hidden />
      {until(expiresAt)}
      {near && <span className="sr-only"> (approaching)</span>}
    </span>
  );
}

export function WriteState({ state }: { state: 'queued' | 'stored' | 'failed' }) {
  if (state === 'stored') return null;
  return state === 'queued' ? (
    <span className="small faint row" style={{ gap: 4 }} title="Saving to storage">
      <Clock size={12} aria-hidden />
      Saving to storage
    </span>
  ) : (
    <span className="small row" style={{ gap: 4, color: 'var(--s-stale)' }}>
      <XCircle size={12} aria-hidden />
      Not stored
    </span>
  );
}

/* ---------- layout bits ---------- */
export function PageHead({
  title,
  desc,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      <div className="row wrap">{children}</div>
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx('card', flush && 'flush', className)}>
      {(title || actions) && (
        <div className="card-h">
          <h4>{title}</h4>
          <div className="row">{actions}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  loading,
  children,
}: {
  label: string;
  value?: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      {loading ? (
        <div className="skel" style={{ height: 32, marginTop: 6 }} />
      ) : (
        <div className="v">{value}</div>
      )}
      {sub && <div className="d muted">{sub}</div>}
      {children}
    </div>
  );
}

export function Banner({
  kind = 'info',
  children,
  action,
  full,
}: {
  kind?: 'info' | 'warning' | 'error' | 'success';
  children: ReactNode;
  action?: ReactNode;
  full?: boolean;
}) {
  const c = {
    info: 'var(--s-proposed)',
    warning: 'var(--s-contested)',
    error: 'var(--s-stale)',
    success: 'var(--s-confirmed)',
  }[kind];
  const I = { info: Info, warning: AlertTriangle, error: XCircle, success: CheckCircle2 }[kind];
  return (
    <div className={cx('banner', full && 'full')} style={sv(c)} role={kind === 'error' ? 'alert' : 'status'}>
      <I size={16} style={{ color: c, marginTop: 3, flex: 'none' }} aria-hidden />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

export function Untrusted() {
  return (
    <div className="untrusted">
      <strong>Untrusted data.</strong> This text was written by an agent and is shown as data, not
      instructions.
    </div>
  );
}

export function Empty({ icon, text, children }: { icon?: ReactNode; text: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Search size={28} aria-hidden />}
      <div style={{ maxWidth: 440 }}>{text}</div>
      {children}
    </div>
  );
}

export function Skeleton({ rows = 5, h = 36 }: { rows?: number; h?: number }) {
  return (
    <div className="col" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ height: h }} />
      ))}
    </div>
  );
}

export function ErrorBlock({ error, retry }: { error: ApiError | Error; retry?: () => void }) {
  const perm = error instanceof ApiError && error.status === 403;
  const net = error instanceof ApiError && error.status === 0;
  return (
    <div className="empty" role="alert">
      {perm ? <Lock size={28} /> : <AlertTriangle size={28} />}
      <div>
        {perm
          ? 'You do not have access to this. Ask a workspace admin to grant it.'
          : net
            ? 'We could not reach the Buiry service.'
            : error.message}
      </div>
      {error instanceof ApiError && error.requestId && (
        <div className="faint small mono">request {error.requestId}</div>
      )}
      {retry && !perm && <Button onClick={retry}>Retry</Button>}
    </div>
  );
}

/** Wraps a query result: skeleton while loading, error block on failure, content otherwise. */
export function Async<T>({
  q,
  children,
  rows,
  empty,
}: {
  q: { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void };
  children: (d: T) => ReactNode;
  rows?: number;
  empty?: ReactNode;
}) {
  if (q.loading) return <Skeleton rows={rows ?? 4} />;
  if (q.error && q.data === undefined) return <ErrorBlock error={q.error} retry={q.reload} />;
  if (q.data === undefined) return empty ? <>{empty}</> : null;
  return <>{children(q.data)}</>;
}

/* ---------- form ---------- */
export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {help && <span className="help">{help}</span>}
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string; n?: number }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} onClick={() => onChange(i.id)}>
          {i.label}
          {i.n !== undefined && <span className="n">{i.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string }[];
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} aria-pressed={value === i.id} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Usage({ used, limit, label }: { used: number; limit: number; label?: string }) {
  const r = limit > 0 ? used / limit : 0;
  return (
    <div title={label}>
      <div
        className={cx('usage', r >= 1 ? 'over' : r >= 0.8 ? 'near' : '')}
        role="progressbar"
        aria-valuenow={used}
        aria-valuemax={limit}
        aria-label={label}
      >
        <i style={{ width: `${Math.min(100, Math.round(r * 100))}%` }} />
      </div>
    </div>
  );
}

export function Sparkline({
  values,
  w = 90,
  h = 24,
  color = 'var(--brand)',
}: {
  values: number[];
  w?: number;
  h?: number;
  color?: string;
}) {
  if (values.length < 2) return <span className="faint small">no history</span>;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const pts = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * (w - 2) + 1},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`,
    )
    .join(' ');
  return (
    <svg
      className="sparkline"
      width={w}
      height={h}
      role="img"
      aria-label={`Trend, ${values.length} points, latest ${values[values.length - 1]}`}
    >
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} />
    </svg>
  );
}

export function StackBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="stack-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <i
            key={p.label}
            title={`${p.label}: ${p.value}`}
            style={{ ...sv(p.color), width: `${(p.value / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

/* ---------- overlays ---------- */
function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    return () => prev?.focus?.();
  }, [open]);
  useKey('escape', onClose, [open, onClose]);
  return ref;
}

export function Drawer({
  open,
  onClose,
  header,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <aside
        ref={ref}
        className={cx('drawer', wide && 'wide')}
        role="dialog"
        aria-modal="true"
        aria-label="Details"
      >
        <div className="dh">
          <div className="spread">
            <div className="grow">{header}</div>
            <Button variant="ghost" aria-label="Close" onClick={onClose}>
              <X size={16} />
            </Button>
          </div>
        </div>
        <div className="db">{children}</div>
        {footer && <div className="df">{footer}</div>}
      </aside>
    </>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  large,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  large?: boolean;
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        className={cx('modal', large && 'lg')}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Dialog'}
      >
        <div className="mh">
          <h3>{title}</h3>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
        <div className="mb">{children}</div>
        {footer && <div className="mf">{footer}</div>}
      </div>
    </>
  );
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  typeName,
  danger,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  typeName?: string;
  danger?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();
  useEffect(() => {
    if (!open) setText('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            className={danger ? 'solid' : ''}
            loading={busy}
            disabled={!!typeName && text !== typeName}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                toast('error', (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{body}</div>
      {typeName && (
        <Field label={`Type "${typeName}" to continue`}>
          {(id) => (
            <input
              id={id}
              className="inp"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
      )}
    </Modal>
  );
}

export function Popover({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  useKey('escape', () => setOpen(false), []);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className="menu" style={{ [align]: 0, top: '100%', marginTop: 4 }} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast"
          style={sv(
            t.kind === 'error'
              ? 'var(--s-stale)'
              : t.kind === 'success'
                ? 'var(--s-confirmed)'
                : 'var(--s-proposed)',
          )}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          {t.kind === 'error' ? (
            <XCircle size={16} style={{ color: 'var(--s-stale)' }} />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={16} style={{ color: 'var(--s-confirmed)' }} />
          ) : (
            <Info size={16} />
          )}
          <span className="grow">{t.text}</span>
          {t.action && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </Button>
          )}
          <Button variant="ghost" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function TokenReveal({ token, hint }: { token: string; hint?: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="col">
      <Banner kind="warning">This value is shown once. Copy it now; Buiry cannot show it again.</Banner>
      <div className="code">
        {shown ? token : `${token.slice(0, 8)}${'•'.repeat(24)}`}
        <CopyButton value={token} />
      </div>
      <div className="row">
        <Button size="sm" onClick={() => setShown((s) => !s)}>
          {shown ? 'Hide' : 'Reveal'}
        </Button>
        {hint}
      </div>
    </div>
  );
}

export function Chev({ open }: { open: boolean }) {
  return <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} aria-hidden />;
}

export function Help({ text }: { text: string }) {
  return (
    <span title={text} aria-label={text} style={{ display: 'inline-flex', color: 'var(--text-tertiary)' }}>
      <CircleHelp size={14} />
    </span>
  );
}

export { ago, exact, cx, sv };
export function useConfirmSuccess() {
  return useApp().toast;
}
