export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'unknown';
  const d = Math.round((Date.parse(iso) - now) / 86_400_000);
  if (d < 0) return 'expired';
  if (d === 0) return 'today';
  return `${d}d`;
}
export const exact = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '');
export const dateOnly = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toISOString().slice(0, 10) : 'unknown';
export const short = (id: string | null | undefined, n = 10): string => {
  if (!id) return '';
  return id.length <= n * 2 + 1 ? id : `${id.slice(0, n)}…${id.slice(-4)}`;
};
export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const band = (c: number): 'low' | 'medium' | 'high' =>
  c < 0.4 ? 'low' : c <= 0.7 ? 'medium' : 'high';
export const initials = (s: string): string =>
  s
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join('') || '?';
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const typeLabel = (t: string): string => t.replace('_', ' ');
export function evidenceLabel(e: { kind: string; [k: string]: unknown }): string {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '');
  switch (e.kind) {
    case 'tx':
      return short(s('digest'));
    case 'object':
      return short(s('id'));
    case 'package':
      return short(s('id'));
    case 'file':
      return `${s('path')}${s('commit') ? ` @ ${s('commit').slice(0, 7)}` : ''}`;
    case 'url':
      return s('href').replace(/^https?:\/\//, '');
    case 'test':
      return `${s('name')}: ${s('result')}`;
    default:
      return e.kind;
  }
}
/** Past or future, relative to now ("in 6h", "5m ago"). */
export function when(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  if (diff <= 0) return ago(iso, now);
  const s = Math.round(diff / 1000);
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}
