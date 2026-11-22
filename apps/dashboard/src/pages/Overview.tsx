import { Link } from 'react-router-dom';
import { useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { api, qs } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago, dateOnly, plural, typeLabel } from '../lib/format';
import {
  MEM_TYPES,
  STATUSES,
  type Activity,
  type Agent,
  type Flag,
  type Memory,
  type Overview as OverviewT,
  type Verification,
} from '../lib/types';
import {
  Async,
  AgentBadge,
  Banner,
  BranchPill,
  Button,
  Card,
  CodeBlock,
  Empty,
  ErrorBlock,
  PageHead,
  Stat,
  StackBar,
  StatusChip,
  TypeChip,
  Usage,
  Sparkline,
  ExpiryIndicator,
} from '../components/ui';

const STATUS_COLOR: Record<string, string> = {
  proposed: 'var(--s-proposed)',
  confirmed: 'var(--s-confirmed)',
  contested: 'var(--s-contested)',
  stale: 'var(--s-stale)',
  superseded: 'var(--s-superseded)',
  tombstoned: 'var(--s-tombstoned)',
};

export function Overview() {
  const { projectId, base, status, openMemory, project, branch } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const ov = useQuery(() => api<OverviewT>(`/v1/projects/${projectId}`.concat('/overview')), [projectId], {
    live: true,
  });
  const flags = useQuery(() => api<Flag[]>(`/v1/projects/${projectId}/flags`), [projectId], { live: true });
  const attention = useQuery(
    () =>
      api<{ items: Memory[] }>(
        `/v1/projects/${projectId}/memories${qs({ status: ['proposed', 'contested', 'stale'], limit: 6, sort: 'confidence' })}`,
      ),
    [projectId],
    { live: true },
  );
  const ver = useQuery(() => api<Verification>(`/v1/projects/${projectId}/verification`), [projectId], {
    live: true,
  });
  const act = useQuery(
    () => api<{ items: Activity[] }>(`/v1/projects/${projectId}/activity?limit=10`),
    [projectId],
    { live: true },
  );
  const agents = useQuery(() => api<Agent[]>(`/v1/projects/${projectId}/agents`), [projectId], {
    live: true,
  });
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const total = ov.data?.byTypeAndStatus.reduce((a, r) => a + r.count, 0) ?? 0;
  const confirmed =
    ov.data?.byTypeAndStatus.filter((r) => r.status === 'confirmed').reduce((a, r) => a + r.count, 0) ?? 0;
  const openFlags = flags.data?.filter((f) => f.state === 'open').length ?? 0;
  const active24 = ov.data?.agents.filter((a) => a.activeLast24h).length ?? 0;
  const s = status.data;
  const confirm = async (id: string) => {
    try {
      await api(`/v1/memories/${id}/confirm`, { method: 'POST', body: {} });
      toast('success', 'Memory confirmed.');
      bump();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const fresh = total === 0 && !ov.loading;

  return (
    <div className="page">
      <PageHead
        title={project?.name ?? 'Overview'}
        desc={
          <span className="row wrap">
            {project?.networks.map((n) => (
              <span className="chip" key={n}>
                {n}
              </span>
            ))}
            <BranchPill name={branch} />
            <span className="chip">{project?.walrusMode ?? 'managed'} storage</span>
          </span>
        }
      >
        <Link className="btn primary" to={`${base}/memory`}>
          Open memory
        </Link>
      </PageHead>

      <div className="grid g5">
        <Stat
          label="Memories"
          value={total}
          loading={ov.loading}
          sub={
            <Sparkline
              values={[
                Math.max(0, total - 6),
                Math.max(0, total - 5),
                Math.max(0, total - 3),
                Math.max(0, total - 2),
                total,
              ]}
            />
          }
        />
        <Stat
          label="Confirmed share"
          value={total ? `${Math.round((confirmed / total) * 100)}%` : '0%'}
          loading={ov.loading}
          sub={`${confirmed} of ${total}`}
        />
        <Stat
          label="Open flags"
          value={openFlags}
          loading={flags.loading}
          sub={<Link to={`${base}/alerts`}>View alerts</Link>}
        />
        <Stat
          label="Agents active"
          value={active24}
          loading={ov.loading}
          sub={`${ov.data?.agents.length ?? 0} connected, last 24 hours`}
        />
        <Stat
          label="Expiring soon"
          value={s?.expiry.expiring ?? 0}
          loading={status.loading}
          sub={
            <Link to={`${base}/storage`}>
              {s?.expiry.soonest ? `Soonest ${dateOnly(s.expiry.soonest)}` : 'Storage health'}
            </Link>
          }
        />
      </div>

      {fresh ? (
        <Card title="Get started" className="mt">
          <ol className="col small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>
              Connect an agent: <CodeBlock value="npx buiry connect claude-code" />
            </li>
            <li>Let it write its first memory.</li>
            <li>Confirm it here.</li>
          </ol>
          <div className="mt">
            <Link className="btn" to={`${base}/agents?connect=1`}>
              Connect an agent
            </Link>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid g21 mt">
            <Card
              title="Needs attention"
              actions={
                <Link to={`${base}/memory`} className="small">
                  All memories
                </Link>
              }
              flush
            >
              <Async q={attention} rows={4}>
                {(r) => {
                  const rows = r.items.filter((m) => !dismissed.has(m.id) && m.type !== 'handoff');
                  return rows.length === 0 ? (
                    <Empty icon={<CheckCircle2 size={28} />} text="Nothing needs attention." />
                  ) : (
                    <div>
                      {rows.map((m) => (
                        <div
                          key={m.id}
                          className="row wrap"
                          style={{
                            padding: '10px 16px',
                            borderTop: '1px solid var(--border-subtle)',
                            alignItems: 'flex-start',
                          }}
                        >
                          <div className="grow col" style={{ gap: 4, flexBasis: 200 }}>
                            <div className="clamp2">
                              <button
                                className="btn ghost sm"
                                style={{ padding: 0, textAlign: 'left', whiteSpace: 'normal' }}
                                onClick={() => openMemory(m.id)}
                              >
                                {m.text}
                              </button>
                            </div>
                            <div className="row wrap small muted">
                              <StatusChip status={m.status} />
                              <TypeChip type={m.type} />
                              {m.flags
                                .filter((f) => f !== m.status)
                                .map((f) => (
                                  <span className="chip" key={f}>
                                    {f.replace('_', ' ')}
                                  </span>
                                ))}
                              <span>
                                {m.status === 'proposed'
                                  ? 'awaiting review'
                                  : m.status === 'stale'
                                    ? 'evidence changed'
                                    : 'contested'}{' '}
                                · {ago(m.updatedAt)}
                              </span>
                            </div>
                          </div>
                          <div className="row">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!can(role, 'admin') || m.status === 'stale'}
                              title={
                                !can(role, 'admin')
                                  ? 'You need Admin access to confirm.'
                                  : m.status === 'stale'
                                    ? 'Re-verify or supersede stale memories'
                                    : undefined
                              }
                              onClick={() => confirm(m.id)}
                            >
                              Confirm
                            </Button>
                            <Button size="sm" onClick={() => openMemory(m.id)}>
                              Open
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDismissed(new Set(dismissed).add(m.id))}
                            >
                              Dismiss
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                }}
              </Async>
            </Card>
            <Card
              title="Verification"
              actions={
                <Link to={`${base}/verification`} className="small">
                  Details
                </Link>
              }
            >
              <Async q={ver} rows={3}>
                {(v) => (
                  <div className="col">
                    <div className="row">
                      <ShieldCheck size={16} />
                      <i className={`live-dot ${v.gateway.state === 'ok' ? 'on' : 'retry'}`} />
                      <strong>
                        {v.gateway.state === 'ok' ? 'Gateway healthy' : `Gateway ${v.gateway.state}`}
                      </strong>
                    </div>
                    <StackBar
                      parts={[
                        { label: 'gRPC', value: v.gateway.transportMix.grpc ?? 0, color: 'var(--brand)' },
                        {
                          label: 'JSON-RPC',
                          value: v.gateway.transportMix.jsonrpc ?? 0,
                          color: 'var(--s-proposed)',
                        },
                        {
                          label: 'cache',
                          value: v.gateway.transportMix.cache ?? 0,
                          color: 'var(--s-superseded)',
                        },
                      ]}
                    />
                    <div className="small muted">
                      {v.gateway.calls} calls · p95 {Math.round(v.gateway.latencyP95)} ms
                    </div>
                    {v.credits ? (
                      <div>
                        <Usage used={v.credits.used} limit={v.credits.budget} label="Verification credits" />
                        <div className="small muted">
                          {v.credits.used} of {v.credits.budget} credits this period
                        </div>
                      </div>
                    ) : (
                      <div className="small muted">~{v.gateway.creditsEstimated} credits used</div>
                    )}
                  </div>
                )}
              </Async>
            </Card>
          </div>

          <div className="grid g21 mt">
            <Card
              title="Recent activity"
              actions={
                <Link to={`${base}/activity`} className="small">
                  View all
                </Link>
              }
              flush
            >
              <Async q={act} rows={5}>
                {(r) => (
                  <div>
                    {r.items.map((a) => (
                      <div
                        key={a.id}
                        className="row small"
                        style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)' }}
                      >
                        <AgentBadge name={a.actor_id ?? 'system'} />
                        <span className="chip">{a.operation}</span>
                        <span className="muted trunc grow">
                          {String(
                            (a.target as { memoryId?: string } | null)?.memoryId ??
                              (a.target as { type?: string } | null)?.type ??
                              '',
                          )}
                        </span>
                        <span className="faint">{a.result}</span>
                        <span className="faint">{ago(a.created_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Async>
            </Card>
            <Card
              title="Agents"
              actions={
                <Link to={`${base}/agents`} className="small">
                  Manage
                </Link>
              }
            >
              <Async q={agents} rows={3}>
                {(r) =>
                  r.length === 0 ? (
                    <p className="muted small">No agents connected.</p>
                  ) : (
                    <div className="col">
                      {r.map((a) => (
                        <div key={a.id} className="spread">
                          <AgentBadge name={a.slug} tool={a.tool} status={a.status} />
                          <span className="small muted">
                            {a.status} · {plural(a.writes7d, 'write')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                }
              </Async>
            </Card>
          </div>

          <Card title="Memory by type and status" className="mt">
            <Async q={ov} rows={4}>
              {(o) => (
                <div className="col">
                  {MEM_TYPES.map((t) => {
                    const rows = o.byTypeAndStatus.filter((r) => r.type === t);
                    const n = rows.reduce((a, r) => a + r.count, 0);
                    return (
                      <div className="hbar" key={t}>
                        <span className="lab small">{typeLabel(t)}</span>
                        <div className="grow">
                          <StackBar
                            parts={STATUSES.map((st) => ({
                              label: st,
                              value: rows.find((r) => r.status === st)?.count ?? 0,
                              color: STATUS_COLOR[st]!,
                            }))}
                          />
                        </div>
                        <span className="mono small" style={{ width: 28, textAlign: 'right' }}>
                          {n}
                        </span>
                      </div>
                    );
                  })}
                  <div className="row wrap small muted">
                    {STATUSES.map((st) => (
                      <span key={st} className="row" style={{ gap: 4 }}>
                        <i className="live-dot" style={{ background: STATUS_COLOR[st] }} />
                        {st}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Async>
          </Card>

          <Card
            title="Storage health"
            actions={
              <Link to={`${base}/storage`} className="small">
                Details
              </Link>
            }
            className="mt"
          >
            {status.error && !s ? (
              <ErrorBlock error={status.error} retry={status.reload} />
            ) : (
              <div className="row wrap" style={{ gap: 24 }}>
                <span className="row">
                  <i
                    className={`live-dot ${s?.relayer.state === 'ok' ? 'on' : s?.relayer.state === 'unknown' ? 'off' : 'retry'}`}
                  />{' '}
                  Relayer: {s?.relayer.state ?? '…'}
                </span>
                <span>
                  Queue: {(s?.queue.queued ?? 0) + (s?.queue.submitting ?? 0) + (s?.queue.submitted ?? 0)}{' '}
                  pending, {s?.queue.dead ?? 0} failed
                </span>
                <span className="row">
                  Soonest expiry: <ExpiryIndicator expiresAt={s?.expiry.soonest ?? null} />{' '}
                  {s?.expiry.soonest && <span className="muted">({dateOnly(s.expiry.soonest)})</span>}
                </span>
              </div>
            )}
          </Card>
          {s && s.queue.dead > 0 && (
            <Banner kind="error" action={<Link to={`${base}/storage`}>Review</Link>}>
              <span className="mt-s">{plural(s.queue.dead, 'write')} could not be stored.</span>
            </Banner>
          )}
        </>
      )}
    </div>
  );
}
