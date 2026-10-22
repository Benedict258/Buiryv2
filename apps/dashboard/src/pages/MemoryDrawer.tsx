import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, CheckCircle2, ExternalLink, RefreshCw, Replace, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago, dateOnly, exact, pct } from '../lib/format';
import type { MemoryDetail, MemoryEvent, Memory, Status } from '../lib/types';
import {
  Async,
  BranchPill,
  Button,
  ConfidenceMeter,
  Drawer,
  EvidenceChip,
  ExpiryIndicator,
  IdBlock,
  Modal,
  Sparkline,
  StatusChip,
  Tabs,
  TypeChip,
  Untrusted,
  Field,
  Banner,
} from '../components/ui';
import { MemoryEditor } from './MemoryEditor';

type Tab = 'overview' | 'evidence' | 'lineage' | 'provenance' | 'history';

const REASONS: Record<string, string> = {
  'memory.created': 'created',
  'memory.reported': 'agent report',
  'memory.validated': 'evidence check',
  'memory.stale': 'marked stale',
  'memory.confirmed': 'confirmed',
  'memory.contested': 'contested',
  'memory.superseded': 'superseded',
  'memory.tombstoned': 'tombstoned',
  'memory.promoted': 'promoted',
};

export function MemoryDrawer({
  id,
  onClose,
  onNavigate,
}: {
  id: string | null;
  onClose: () => void;
  onNavigate?: (id: string) => void;
}) {
  const { role } = useWs();
  const { toast, bump } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const q = useQuery(
    () => (id ? api<MemoryDetail>(`/v1/memories/${id}`) : Promise.resolve(undefined as never)),
    [id],
    { live: true },
  );
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [contest, setContest] = useState(false);
  const [reason, setReason] = useState('');
  const d = q.data;

  const act = async (action: 'confirm' | 'contest' | 'tombstone', body: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      await api(`/v1/memories/${id}/${action}`, { method: 'POST', body });
      bump();
      q.reload();
      if (action === 'tombstone')
        toast('success', 'Memory withdrawn.', {
          label: 'Undo',
          run: () =>
            void api(`/v1/memories/${id}/confirm`, { method: 'POST', body: {} })
              .then(() => {
                bump();
                q.reload();
              })
              .catch((e) => toast('error', e.message)),
        });
      else toast('success', action === 'confirm' ? 'Memory confirmed.' : 'Memory contested.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const writer = can(role, 'writer');
  const admin = can(role, 'admin');
  const why = (need: string) => `You need ${need} access. Ask an admin.`;
  const status: Status | undefined = d?.status;

  return (
    <>
      <Drawer
        open={!!id}
        onClose={onClose}
        header={
          d ? (
            <div className="col" style={{ gap: 6 }}>
              <div className="row wrap">
                <TypeChip type={d.type} />
                <StatusChip status={d.status} />
                <BranchPill name={d.branch} />
              </div>
              <IdBlock value={d.memoryId} n={14} />
            </div>
          ) : (
            <div className="skel" style={{ height: 40 }} />
          )
        }
        footer={
          d && (
            <>
              <Button
                variant="primary"
                icon={<CheckCircle2 size={14} />}
                loading={busy === 'confirm'}
                disabled={
                  !admin || status === 'confirmed' || status === 'tombstoned' || status === 'superseded'
                }
                title={!admin ? why('admin') : status === 'confirmed' ? 'Already confirmed' : undefined}
                onClick={() => act('confirm')}
              >
                Confirm
              </Button>
              <Button
                icon={<ShieldAlert size={14} />}
                disabled={!writer || status === 'contested' || status === 'tombstoned'}
                title={!writer ? why('writer') : undefined}
                onClick={() => setContest(true)}
              >
                Contest
              </Button>
              <Button
                icon={<Replace size={14} />}
                disabled={!writer || status === 'tombstoned' || status === 'superseded'}
                title={!writer ? why('writer') : undefined}
                onClick={() => setEditing(true)}
              >
                Supersede
              </Button>
              <Button
                variant="danger"
                icon={<Ban size={14} />}
                loading={busy === 'tombstone'}
                disabled={!admin || status === 'tombstoned'}
                title={!admin ? why('admin') : undefined}
                onClick={() => act('tombstone')}
              >
                Withdraw from recall
              </Button>
            </>
          )
        }
      >
        <Async q={q} rows={6}>
          {(m) => (
            <>
              <Tabs
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'overview', label: 'Overview' },
                  { id: 'evidence', label: 'Evidence', n: m.evidence.length },
                  { id: 'lineage', label: 'Lineage' },
                  { id: 'provenance', label: 'Provenance' },
                  { id: 'history', label: 'History', n: m.events.length },
                ]}
              />
              {tab === 'overview' && <Overview m={m} />}
              {tab === 'evidence' && (
                <EvidenceList
                  m={m}
                  onChange={() => {
                    q.reload();
                    bump();
                  }}
                  canVerify={writer}
                />
              )}
              {tab === 'lineage' && <Lineage m={m} go={(x) => onNavigate?.(x)} />}
              {tab === 'provenance' && <Provenance m={m} />}
              {tab === 'history' && <History events={m.events} />}
            </>
          )}
        </Async>
      </Drawer>
      <Modal
        open={contest}
        onClose={() => setContest(false)}
        title="Contest this memory"
        footer={
          <>
            <Button onClick={() => setContest(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === 'contest'}
              onClick={async () => {
                await act('contest', reason ? { reason } : {});
                setContest(false);
                setReason('');
              }}
            >
              Contest
            </Button>
          </>
        }
      >
        <p className="muted">Contested memories are flagged for review and ranked lower in briefings.</p>
        <Field label="Reason (optional)">
          {(i) => (
            <textarea
              id={i}
              className="inp"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </Modal>
      {d && editing && (
        <MemoryEditor
          open
          onClose={() => setEditing(false)}
          supersede={d}
          onSaved={(nid) => {
            setEditing(false);
            bump();
            onNavigate?.(nid);
          }}
        />
      )}
    </>
  );
}

function Overview({ m }: { m: MemoryDetail }) {
  const changes = m.events.filter(
    (e) => typeof e.payload.after === 'number' || typeof e.payload.confidence === 'number',
  );
  const series = changes.map((e) => Number(e.payload.after ?? e.payload.confidence));
  return (
    <div className="col">
      {m.status === 'proposed' && <Untrusted />}
      <p className="pre" style={{ userSelect: 'text' }}>
        {m.text}
      </p>
      <div className="card">
        <div className="label">Confidence</div>
        <div className="spread mt-s">
          <ConfidenceMeter value={m.confidence} large />
          <Sparkline values={series} />
        </div>
        <div className="col mt-s" style={{ gap: 4 }}>
          {changes
            .filter((e) => typeof e.payload.before === 'number')
            .slice(-6)
            .reverse()
            .map((e) => {
              const delta = Number(e.payload.after) - Number(e.payload.before);
              return (
                <div key={e.id} className="small row">
                  <span
                    className="mono"
                    style={{ color: delta >= 0 ? 'var(--s-confirmed)' : 'var(--s-stale)' }}
                  >
                    {delta >= 0 ? '+' : ''}
                    {delta.toFixed(2)}
                  </span>
                  <span className="muted">
                    {REASONS[e.type] ?? e.type}
                    {e.actor_id ? ` by ${e.actor_id}` : ''}
                  </span>
                  <span className="faint" style={{ marginLeft: 'auto' }}>
                    {ago(e.created_at)}
                  </span>
                </div>
              );
            })}
          {changes.filter((e) => typeof e.payload.before === 'number').length === 0 && (
            <span className="faint small">No score changes yet.</span>
          )}
        </div>
      </div>
      <div className="small muted">{statusSentence(m.status)}</div>
    </div>
  );
}
function statusSentence(s: Status): string {
  return {
    proposed: 'Written by an agent and not yet confirmed. It is used with lower weight in briefings.',
    confirmed: 'Confirmed. It is surfaced with full weight in briefings.',
    contested: 'Conflicts with another memory or was reported wrong. It is flagged to agents.',
    stale: 'Its evidence no longer matches the current state. Agents are warned before relying on it.',
    superseded: 'Replaced by a newer memory and no longer recalled.',
    tombstoned: 'Withdrawn from recall. It stays in storage and can be restored.',
  }[s];
}

function EvidenceList({
  m,
  onChange,
  canVerify,
}: {
  m: MemoryDetail;
  onChange: () => void;
  canVerify: boolean;
}) {
  const { toast } = useApp();
  const { projectId } = useProject();
  const [results, setResults] = useState<
    Record<number, { result: string; detail: string; degraded: boolean; observed?: Record<string, unknown> }>
  >({});
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const run = async (i: number | 'all') => {
    setBusy(i);
    try {
      const body = i === 'all' ? { memoryId: m.memoryId } : { evidence: m.evidence[i] };
      const r = await api<{
        results: { result: string; detail: string; degraded: boolean; observed?: Record<string, unknown> }[];
      }>(`/v1/projects/${projectId}/verifications`, { method: 'POST', body });
      setResults((prev) => {
        const next = { ...prev };
        r.results.forEach((x, k) => {
          next[i === 'all' ? k : i] = x;
        });
        return next;
      });
      onChange();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (m.evidence.length === 0)
    return (
      <div className="muted small">
        No evidence attached. Agents can add transactions, objects, packages, files, URLs and test results
        when they record a memory.
      </div>
    );
  return (
    <div className="col">
      {m.evidence.map((e, i) => {
        const r = results[i];
        return (
          <div className="card" key={i}>
            <div className="spread">
              <EvidenceChip e={e} result={r?.result} />
              <Button
                size="sm"
                icon={<RefreshCw size={12} />}
                loading={busy === i}
                disabled={!canVerify}
                onClick={() => run(i)}
              >
                Re-verify
              </Button>
            </div>
            <div className="small muted mt-s">
              {r ? r.detail : 'Not checked in this view.'}
              {r?.degraded ? ' (chain gateway degraded)' : ''}
            </div>
            {r?.observed && (
              <pre className="code small mt-s" style={{ margin: 0 }}>
                {JSON.stringify(r.observed, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
      <Button onClick={() => run('all')} loading={busy === 'all'} disabled={!canVerify}>
        Re-verify all
      </Button>
    </div>
  );
}

function Lineage({ m, go }: { m: MemoryDetail; go: (id: string) => void }) {
  const prev = useQuery(
    () =>
      m.supersedes ? api<MemoryDetail>(`/v1/memories/${m.supersedes}`) : Promise.resolve(undefined as never),
    [m.supersedes],
  );
  const next = useQuery(
    () =>
      m.supersededBy
        ? api<MemoryDetail>(`/v1/memories/${m.supersededBy}`)
        : Promise.resolve(undefined as never),
    [m.supersededBy],
  );
  if (!m.supersedes && !m.supersededBy)
    return <div className="muted small">This memory has no predecessors or successors.</div>;
  return (
    <div className="col">
      {m.supersededBy && next.data && <LineageCard label="Superseded by" mem={next.data} go={go} />}
      <div className="card" style={{ borderColor: 'var(--brand)' }}>
        <div className="label">This memory</div>
        <p className="pre mt-s">{m.text}</p>
      </div>
      {m.supersedes && prev.data && (
        <>
          <LineageCard label="Supersedes" mem={prev.data} go={go} />
          <TextDiff before={prev.data.text} after={m.text} />
        </>
      )}
    </div>
  );
}
function LineageCard({ label, mem, go }: { label: string; mem: MemoryDetail; go: (id: string) => void }) {
  return (
    <div className="card">
      <div className="spread">
        <span className="label">{label}</span>
        <StatusChip status={mem.status} />
      </div>
      <p className="pre mt-s">{mem.text}</p>
      <Button size="sm" variant="ghost" onClick={() => go(mem.memoryId)} icon={<ExternalLink size={12} />}>
        Open
      </Button>
    </div>
  );
}
export function TextDiff({ before, after }: { before: string; after: string }) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const setA = new Set(a.filter((x) => x.trim()));
  const setB = new Set(b.filter((x) => x.trim()));
  return (
    <div className="grid g2">
      <div className="card">
        <div className="label">Before</div>
        <p className="pre mt-s">
          {a.map((w, i) =>
            w.trim() && !setB.has(w) ? (
              <span key={i} className="diff-del">
                {w}
              </span>
            ) : (
              w
            ),
          )}
        </p>
      </div>
      <div className="card">
        <div className="label">After</div>
        <p className="pre mt-s">
          {b.map((w, i) =>
            w.trim() && !setA.has(w) ? (
              <span key={i} className="diff-add">
                {w}
              </span>
            ) : (
              w
            ),
          )}
        </p>
      </div>
    </div>
  );
}

function Provenance({ m }: { m: MemoryDetail }) {
  return (
    <div className="col">
      <dl className="col small" style={{ margin: 0 }}>
        <Row k="Written by" v={m.agent} />
        <Row k="Branch" v={<BranchPill name={m.branch} />} />
        <Row k="Created" v={`${exact(m.createdAt)} (${ago(m.createdAt)})`} />
        <Row k="Storage state" v={m.writeState} />
        <Row
          k="Blob"
          v={
            m.walrusBlobId ? (
              <IdBlock value={m.walrusBlobId} n={12} />
            ) : (
              <span className="faint">not stored yet</span>
            )
          }
        />
        <Row
          k="Expires"
          v={
            m.expiresAt ? (
              <span className="row">
                <ExpiryIndicator expiresAt={m.expiresAt} />
                <span className="muted">{dateOnly(m.expiresAt)}</span>
              </span>
            ) : (
              <span className="faint">unknown</span>
            )
          }
        />
      </dl>
      {m.writeState === 'queued' && (
        <Banner kind="info">
          Saving to storage. This memory is readable now and will be stored shortly.
        </Banner>
      )}
      {m.writeState === 'failed' && (
        <Banner kind="error">Could not store this memory. See Storage health to retry.</Banner>
      )}
      <Link to="../storage" className="small">
        Open storage health
      </Link>
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="spread">
    <dt className="muted">{k}</dt>
    <dd style={{ margin: 0 }}>{v}</dd>
  </div>
);

function History({ events }: { events: MemoryEvent[] }) {
  return (
    <div className="timeline">
      {[...events].reverse().map((e) => (
        <div className="ev" key={e.id}>
          <div className="spread">
            <strong>{REASONS[e.type] ?? e.type}</strong>
            <span className="faint small" title={exact(e.created_at)}>
              {ago(e.created_at)}
            </span>
          </div>
          <div className="small muted">
            {e.actor_kind}
            {e.actor_id ? ` · ${e.actor_id}` : ''} · tier {e.tier}
            {typeof e.payload.after === 'number' ? ` · confidence ${pct(Number(e.payload.after))}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

export type { Memory };
