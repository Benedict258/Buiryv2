import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Ban, CheckCircle2, Download, MoreHorizontal, Plus, Search, XCircle } from 'lucide-react';
import { api, qs } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago } from '../lib/format';
import { MEM_TYPES, STATUSES, type Memory, type Status } from '../lib/types';
import {
  AgentBadge,
  BranchPill,
  Button,
  Card,
  CodeBlock,
  ConfidenceMeter,
  Empty,
  ErrorBlock,
  EvidenceChip,
  ExpiryIndicator,
  Field,
  PageHead,
  Popover,
  Segmented,
  Skeleton,
  StatusChip,
  TypeChip,
  Untrusted,
  WriteState,
} from '../components/ui';
import { MemoryEditor } from './MemoryEditor';

interface Filters {
  q: string;
  type: string[];
  status: string[];
  branch: string;
  agent: string;
  min: number;
  evidence: string;
  expiring: boolean;
  flagged: boolean;
  since: string;
  sort: string;
}
const EMPTY: Filters = {
  q: '',
  type: [],
  status: [],
  branch: '',
  agent: '',
  min: 0,
  evidence: '',
  expiring: false,
  flagged: false,
  since: '',
  sort: 'updated',
};
const VIEWS: Record<string, Partial<Filters>> = {
  'All memories': {},
  'Proposed this week': { status: ['proposed'], since: 'week' },
  Failures: { type: ['failure'] },
  'Needs review': { status: ['proposed', 'contested', 'stale'] },
  'Expiring soon': { expiring: true },
};

export function MemoryExplorer() {
  const { projectId, branch, openMemory, base } = useProject();
  const { role } = useWs();
  const { toast, bump, tick } = useApp();
  const [sp] = useSearchParams();
  const [f, setF] = useState<Filters>(EMPTY);
  const [mode, setMode] = useState<'table' | 'review'>('table');
  const [view, setView] = useState('All memories');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState(false);
  const [rail, setRail] = useState(() => window.innerWidth >= 1560);
  const [limit, setLimit] = useState(50);
  const [mem, setMem] = useState<string | null>(sp.get('memory'));
  const known = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<string[]>([]);
  const upd = (p: Partial<Filters>) => {
    setF((x) => ({ ...x, ...p }));
    setLimit(50);
  };
  const since = f.since === 'week' ? new Date(Date.now() - 7 * 86_400_000).toISOString() : f.since;

  const q = useQuery(
    () =>
      api<{ items: Memory[]; nextCursor: string | null }>(
        `/v1/projects/${projectId}/memories${qs({
          q: f.q,
          type: f.type,
          status: f.status,
          branch: f.branch,
          agent: f.agent,
          minConfidence: f.min || undefined,
          evidence: f.evidence,
          expiring: f.expiring,
          flagged: f.flagged,
          createdAfter: since,
          sort: f.sort,
          limit,
        })}`,
      ),
    [projectId, JSON.stringify(f), limit],
    { live: true },
  );
  useEffect(() => {
    api<{ slug: string }[]>(`/v1/projects/${projectId}/agents`)
      .then((a) => setAgents(a.map((x) => x.slug)))
      .catch(() => {});
  }, [projectId]);
  useEffect(() => {
    if (mem) {
      openMemory(mem);
      setMem(null);
    }
  }, [mem, openMemory]);
  // highlight rows that arrived since the last load
  useEffect(() => {
    const items = q.data?.items ?? [];
    if (known.current.size > 0)
      setFresh(new Set(items.filter((m) => !known.current.has(m.id)).map((m) => m.id)));
    known.current = new Set(items.map((m) => m.id));
    const t = setTimeout(() => setFresh(new Set()), 900);
    return () => clearTimeout(t);
  }, [q.data, tick]);

  const items = q.data?.items ?? [];
  const writer = can(role, 'writer');
  const admin = can(role, 'admin');
  const bulk = async (action: 'confirm' | 'tombstone') => {
    const ids = [...sel];
    const results = await Promise.allSettled(
      ids.map((id) => api(`/v1/memories/${id}/${action}`, { method: 'POST', body: {} })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    toast(
      failed ? 'error' : 'success',
      failed
        ? `${ids.length - failed} updated, ${failed} could not be changed.`
        : `${ids.length} memories ${action === 'confirm' ? 'confirmed' : 'withdrawn'}.`,
    );
    setSel(new Set());
    bump();
  };
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const filtered = JSON.stringify(f) !== JSON.stringify(EMPTY);
  const multi = (key: 'type' | 'status', v: string) =>
    upd({ [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] } as Partial<Filters>);

  return (
    <div className="page wide">
      <PageHead
        title="Memory"
        desc={`${items.length}${q.data?.nextCursor ? '+' : ''} result${items.length === 1 ? '' : 's'} on ${branch === 'main' ? 'all branches' : branch}`}
      >
        <Segmented
          label="View"
          value={mode}
          onChange={setMode}
          items={[
            { id: 'table', label: 'Table' },
            { id: 'review', label: 'Review queue' },
          ]}
        />
        <Link className="btn" to={`${base}/packs`}>
          <Download size={14} /> Export
        </Link>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!writer}
          title={!writer ? 'You need Writer access to add memories.' : undefined}
          onClick={() => setEditor(true)}
        >
          New memory
        </Button>
      </PageHead>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div className="row grow" style={{ position: 'relative', maxWidth: 520 }}>
          <Search
            size={14}
            style={{ position: 'absolute', left: 10, color: 'var(--text-tertiary)' }}
            aria-hidden
          />
          <input
            className="inp"
            style={{ paddingLeft: 32 }}
            placeholder="Search memories"
            aria-label="Search memories"
            value={f.q}
            onChange={(e) => upd({ q: e.target.value })}
          />
        </div>
        <select
          className="inp"
          style={{ width: 'auto' }}
          aria-label="Saved views"
          value={view}
          onChange={(e) => {
            setView(e.target.value);
            setF({ ...EMPTY, ...VIEWS[e.target.value] });
          }}
        >
          {Object.keys(VIEWS).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <Button variant="ghost" className="desktop-only" onClick={() => setRail(!rail)}>
          {rail ? 'Hide filters' : 'Show filters'}
        </Button>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setF(EMPTY);
              setView('All memories');
            }}
          >
            Clear all
          </Button>
        )}
      </div>

      <div className="split">
        {rail && (
          <aside className="filter-rail card col" aria-label="Filters">
            <FilterGroup title="Type">
              {MEM_TYPES.map((t) => (
                <label key={t} className="check small">
                  <input type="checkbox" checked={f.type.includes(t)} onChange={() => multi('type', t)} />
                  {t.replace('_', ' ')}
                </label>
              ))}
            </FilterGroup>
            <FilterGroup title="Status">
              {STATUSES.map((s) => (
                <label key={s} className="check small">
                  <input type="checkbox" checked={f.status.includes(s)} onChange={() => multi('status', s)} />
                  {s}
                </label>
              ))}
            </FilterGroup>
            <Field label="Agent">
              {(id) => (
                <select
                  id={id}
                  className="inp"
                  value={f.agent}
                  onChange={(e) => upd({ agent: e.target.value })}
                >
                  <option value="">Any</option>
                  {agents.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Branch">
              {(id) => (
                <input
                  id={id}
                  className="inp mono"
                  placeholder="any"
                  value={f.branch}
                  onChange={(e) => upd({ branch: e.target.value })}
                />
              )}
            </Field>
            <Field label={`Minimum confidence: ${f.min.toFixed(2)}`}>
              {(id) => (
                <input
                  id={id}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={f.min}
                  onChange={(e) => upd({ min: Number(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Evidence">
              {(id) => (
                <select
                  id={id}
                  className="inp"
                  value={f.evidence}
                  onChange={(e) => upd({ evidence: e.target.value })}
                >
                  <option value="">Any</option>
                  <option value="any">Has evidence</option>
                  <option value="verified">Verified</option>
                  <option value="failed">Failed</option>
                  <option value="none">None</option>
                </select>
              )}
            </Field>
            <label className="check small">
              <input
                type="checkbox"
                checked={f.expiring}
                onChange={(e) => upd({ expiring: e.target.checked })}
              />
              Expiring soon
            </label>
            <label className="check small">
              <input
                type="checkbox"
                checked={f.flagged}
                onChange={(e) => upd({ flagged: e.target.checked })}
              />
              Has open flags
            </label>
            <Field label="Sort">
              {(id) => (
                <select
                  id={id}
                  className="inp"
                  value={f.sort}
                  onChange={(e) => upd({ sort: e.target.value })}
                >
                  <option value="updated">Updated</option>
                  <option value="created">Created</option>
                  <option value="confidence">Confidence</option>
                  <option value="expiry">Expiry</option>
                </select>
              )}
            </Field>
          </aside>
        )}
        <div className="grow" style={{ minWidth: 0 }}>
          {q.loading ? (
            <Skeleton rows={8} />
          ) : q.error && !q.data ? (
            <ErrorBlock error={q.error} retry={q.reload} />
          ) : items.length === 0 ? (
            filtered ? (
              <Empty text="No memories match these filters.">
                <Button onClick={() => setF(EMPTY)}>Clear filters</Button>
              </Empty>
            ) : (
              <Empty text="No memories yet. Connect an agent and its first memory will appear here.">
                <CodeBlock value="npx buiry connect claude-code" />
              </Empty>
            )
          ) : mode === 'review' ? (
            <ReviewQueue
              items={items.filter(
                (m) =>
                  m.type !== 'handoff' &&
                  (m.status === 'proposed' || m.status === 'contested' || m.status === 'stale'),
              )}
              onDone={bump}
              role={role}
            />
          ) : (
            <Card flush>
              <div className="tbl-wrap">
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={sel.size > 0 && sel.size === items.length}
                          onChange={(e) =>
                            setSel(e.target.checked ? new Set(items.map((m) => m.id)) : new Set())
                          }
                        />
                      </th>
                      <th>Status</th>
                      <th>Type</th>
                      <th>Memory</th>
                      <th>Confidence</th>
                      <th>Agent</th>
                      <th>Branch</th>
                      <th>Evidence</th>
                      <th>Updated</th>
                      <th>Expiry</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((m) => (
                      <tr
                        key={m.id}
                        className={`click${sel.has(m.id) ? ' sel' : ''}${fresh.has(m.id) ? ' flash' : ''}`}
                        onClick={() => openMemory(m.id)}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label="Select memory"
                            checked={sel.has(m.id)}
                            onChange={() => toggle(m.id)}
                          />
                        </td>
                        <td>
                          <StatusChip status={m.expired ? 'expired' : m.status} />
                        </td>
                        <td>
                          <TypeChip type={m.type} />
                        </td>
                        <td style={{ maxWidth: 420 }}>
                          <div
                            className={`clamp2${m.status === 'superseded' || m.status === 'tombstoned' || m.expired ? ' struck' : ''}`}
                          >
                            {m.text}
                          </div>
                          <WriteState state={m.writeState} />
                          {m.flags.includes('possible_conflict') && (
                            <span className="chip s" style={{ ['--c' as string]: 'var(--s-contested)' }}>
                              possible conflict
                            </span>
                          )}
                        </td>
                        <td>
                          <ConfidenceMeter
                            value={m.effectiveConfidence}
                            decayed={m.effectiveConfidence < m.confidence - 0.005}
                          />
                        </td>
                        <td>
                          <AgentBadge name={m.agent} />
                        </td>
                        <td>
                          <BranchPill name={m.branch} />
                        </td>
                        <td>
                          <div className="row wrap">
                            {m.evidence.slice(0, 2).map((e, i) => (
                              <EvidenceChip
                                key={i}
                                e={e}
                                result={
                                  m.evidenceResults[i] === 'unchecked' ? undefined : m.evidenceResults[i]
                                }
                              />
                            ))}
                            {m.evidence.length > 2 && <span className="chip">+{m.evidence.length - 2}</span>}
                          </div>
                        </td>
                        <td className="small muted" title={m.updatedAt}>
                          {ago(m.updatedAt)}
                        </td>
                        <td>
                          <ExpiryIndicator expiresAt={m.expiresAt} expired={m.expired} />
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Popover
                            align="right"
                            trigger={({ toggle: t }) => (
                              <button className="btn ghost icon" aria-label="Row actions" onClick={t}>
                                <MoreHorizontal size={16} />
                              </button>
                            )}
                          >
                            {(close) => (
                              <>
                                <button
                                  onClick={() => {
                                    close();
                                    openMemory(m.id);
                                  }}
                                >
                                  Open details
                                </button>
                                <button
                                  onClick={() => {
                                    close();
                                    void navigator.clipboard?.writeText(m.id);
                                    toast('info', 'Memory id copied.');
                                  }}
                                >
                                  Copy id
                                </button>
                                <button
                                  disabled={!admin || m.status === 'confirmed'}
                                  onClick={async () => {
                                    close();
                                    await api(`/v1/memories/${m.id}/confirm`, { method: 'POST', body: {} })
                                      .then(bump)
                                      .catch((e) => toast('error', e.message));
                                  }}
                                >
                                  Confirm
                                </button>
                              </>
                            )}
                          </Popover>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {q.data?.nextCursor && (
                <div style={{ padding: 12, textAlign: 'center' }}>
                  <Button onClick={() => setLimit(limit + 50)}>Load more</Button>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {sel.size > 0 && (
        <div
          className="card row desktop-only"
          style={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            boxShadow: 'var(--shadow-pop)',
          }}
          role="region"
          aria-label="Bulk actions"
        >
          <strong>{sel.size} selected</strong>
          <Button
            variant="primary"
            size="sm"
            icon={<CheckCircle2 size={14} />}
            disabled={!admin}
            title={!admin ? 'You need Admin access.' : undefined}
            onClick={() => bulk('confirm')}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Ban size={14} />}
            disabled={!admin}
            onClick={() => bulk('tombstone')}
          >
            Withdraw
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {editor && <MemoryEditor open onClose={() => setEditor(false)} onSaved={() => bump()} />}
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label" style={{ marginBottom: 4 }}>
        {title}
      </legend>
      <div className="col" style={{ gap: 4 }}>
        {children}
      </div>
    </fieldset>
  );
}

function ReviewQueue({
  items,
  onDone,
  role,
}: {
  items: Memory[];
  onDone: () => void;
  role: Parameters<typeof can>[0];
}) {
  const { toast } = useApp();
  const { openMemory } = useProject();
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const total = items.length;
  const m = items[Math.min(i, total - 1)];
  const act = async (action: 'confirm' | 'contest' | 'tombstone') => {
    if (!m) return;
    setBusy(true);
    try {
      await api(`/v1/memories/${m.id}/${action}`, { method: 'POST', body: {} });
      toast(
        'success',
        action === 'confirm' ? 'Confirmed.' : action === 'contest' ? 'Contested.' : 'Withdrawn.',
      );
      onDone();
      setI((x) => x + 0);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA')
        return;
      if (e.key === 'c' && can(role, 'admin')) void act('confirm');
      if (e.key === 'x') void act('contest');
      if (e.key === 'ArrowRight') setI((x) => Math.min(total - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  if (!m)
    return (
      <Empty
        icon={<CheckCircle2 size={28} />}
        text="The review queue is empty. Nothing is waiting for a decision."
      />
    );
  return (
    <Card
      title={`${Math.min(i, total - 1) + 1} of ${total} to review`}
      actions={<span className="small faint">Shortcuts: C confirm · X contest · ← →</span>}
    >
      <div className="col">
        <div className="row wrap">
          <StatusChip status={m.status} />
          <TypeChip type={m.type} />
          <BranchPill name={m.branch} />
          <AgentBadge name={m.agent} />
        </div>
        {m.status === 'proposed' && <Untrusted />}
        <p style={{ fontSize: 18, lineHeight: '28px' }} className="pre">
          {m.text}
        </p>
        <ConfidenceMeter value={m.effectiveConfidence} large />
        <div className="row wrap">
          {m.evidence.length === 0 ? (
            <span className="faint small">No evidence attached.</span>
          ) : (
            m.evidence.map((e, k) => (
              <EvidenceChip
                key={k}
                e={e}
                result={m.evidenceResults[k] === 'unchecked' ? undefined : m.evidenceResults[k]}
              />
            ))
          )}
        </div>
        <div className="row wrap">
          <Button
            variant="primary"
            icon={<CheckCircle2 size={14} />}
            loading={busy}
            disabled={!can(role, 'admin')}
            onClick={() => act('confirm')}
          >
            Confirm
          </Button>
          <Button
            icon={<XCircle size={14} />}
            loading={busy}
            disabled={!can(role, 'writer')}
            onClick={() => act('contest')}
          >
            Contest
          </Button>
          <Button onClick={() => openMemory(m.id)}>Supersede or details</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!can(role, 'admin')}
            onClick={() => act('tombstone')}
          >
            Tombstone
          </Button>
          <span style={{ marginLeft: 'auto' }} className="row">
            <Button variant="ghost" onClick={() => setI(Math.max(0, i - 1))}>
              Previous
            </Button>
            <Button variant="ghost" onClick={() => setI(Math.min(total - 1, i + 1))}>
              Skip
            </Button>
          </span>
        </div>
      </div>
    </Card>
  );
}

export type { Status };
