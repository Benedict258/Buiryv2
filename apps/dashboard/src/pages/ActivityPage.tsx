import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Pause, Play } from 'lucide-react';
import { api, openStream, qs } from '../lib/api';
import { useApp, useQuery } from '../lib/app';
import { useProject } from '../lib/ctx';
import { ago, exact } from '../lib/format';
import type { Activity } from '../lib/types';
import {
  AgentBadge,
  Button,
  Card,
  CopyButton,
  Empty,
  ErrorBlock,
  PageHead,
  Skeleton,
  cx,
} from '../components/ui';

const OPS = [
  'connect',
  'check',
  'remember',
  'recall',
  'report',
  'resolve',
  'handoff',
  'verify',
  'chain_read',
  'simulate',
  'branch',
  'token',
  'webhook',
  'alert',
];

export function ActivityPage() {
  const { projectId, openMemory } = useProject();
  const { setLive } = useApp();
  const [op, setOp] = useState('');
  const [result, setResult] = useState('');
  const [actor, setActor] = useState('');
  const [live, setLiveOn] = useState(true);
  const [rows, setRows] = useState<Activity[]>([]);
  const [held, setHeld] = useState<Activity[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const liveRef = useRef(live);
  liveRef.current = live;
  const filt = JSON.stringify([op, result, actor]);
  const q = useQuery(
    () =>
      api<{ items: Activity[]; nextCursor: string | null }>(
        `/v1/projects/${projectId}/activity${qs({ operation: op, result, actor, limit: 50 })}`,
      ),
    [projectId, filt],
  );
  useEffect(() => {
    if (q.data) {
      setRows(q.data.items);
      setCursor(q.data.nextCursor);
      setHeld([]);
    }
  }, [q.data]);
  const match = (a: Activity) =>
    (!op || a.operation === op) && (!result || a.result === result) && (!actor || a.actor_id === actor);
  useEffect(() => {
    return openStream(`/v1/projects/${projectId}/activity/stream`, {
      state: setLive,
      event: (n, d) => {
        if (n !== 'activity') return;
        const a = d as Activity;
        if (!match(a)) return;
        if (liveRef.current) {
          setRows((r) => (r.some((x) => x.id === a.id) ? r : [a, ...r]));
          setFlash((f) => new Set(f).add(a.id));
          setTimeout(
            () =>
              setFlash((f) => {
                const n2 = new Set(f);
                n2.delete(a.id);
                return n2;
              }),
            900,
          );
        } else setHeld((h) => [a, ...h]);
      },
    });
  }, [projectId, filt, setLive]);
  const more = async () => {
    if (!cursor) return;
    const r = await api<{ items: Activity[]; nextCursor: string | null }>(
      `/v1/projects/${projectId}/activity${qs({ operation: op, result, actor, limit: 50, cursor })}`,
    );
    setRows((x) => [...x, ...r.items]);
    setCursor(r.nextCursor);
  };
  const exportCsv = () => {
    const head = 'time,actor,operation,result,latency_ms,request_id\n';
    const body = rows
      .map((a) =>
        [
          a.created_at,
          a.actor_id ?? 'system',
          a.operation,
          a.result,
          a.latency_ms ?? '',
          a.request_id ?? '',
        ].join(','),
      )
      .join('\n');
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'activity.csv' }).click();
    URL.revokeObjectURL(url);
  };
  const actors = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] as string[];
  return (
    <div className="page wide">
      <PageHead
        title="Activity"
        desc="An auditable, live record of every call, write, edit, recall, verification and alert."
      >
        <Button
          icon={live ? <Pause size={14} /> : <Play size={14} />}
          onClick={() => {
            if (!live && held.length) {
              setRows((r) => [...held, ...r]);
              setHeld([]);
            }
            setLiveOn(!live);
          }}
          aria-pressed={live}
        >
          {live ? 'Live' : 'Paused'}
        </Button>
        <Button onClick={exportCsv}>Export</Button>
      </PageHead>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <select
          className="inp"
          style={{ width: 'auto' }}
          aria-label="Operation"
          value={op}
          onChange={(e) => setOp(e.target.value)}
        >
          <option value="">All operations</option>
          {OPS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <select
          className="inp"
          style={{ width: 'auto' }}
          aria-label="Result"
          value={result}
          onChange={(e) => setResult(e.target.value)}
        >
          <option value="">Any result</option>
          <option>success</option>
          <option>error</option>
          <option>queued</option>
        </select>
        <select
          className="inp"
          style={{ width: 'auto' }}
          aria-label="Actor"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        >
          <option value="">Any actor</option>
          {actors.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        {held.length > 0 && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setRows((r) => [...held, ...r]);
              setHeld([]);
            }}
          >
            {held.length} new events
          </Button>
        )}
      </div>
      <Card flush>
        {q.loading ? (
          <div style={{ padding: 16 }}>
            <Skeleton rows={8} h={28} />
          </div>
        ) : q.error && !q.data ? (
          <ErrorBlock error={q.error} retry={q.reload} />
        ) : rows.length === 0 ? (
          <Empty text={op || result || actor ? 'No events match these filters.' : 'No activity yet.'} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl cards">
              <thead>
                <tr>
                  <th style={{ width: 24 }} />
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Operation</th>
                  <th>Target</th>
                  <th>Result</th>
                  <th>Latency</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const t = a.target as { memoryId?: string; type?: string } | null;
                  const isOpen = open === a.id;
                  return [
                    <tr
                      key={a.id}
                      className={cx('click', flash.has(a.id) && 'flash')}
                      onClick={() => setOpen(isOpen ? null : a.id)}
                      aria-expanded={isOpen}
                    >
                      <td>
                        <ChevronRight
                          size={14}
                          style={{ transform: isOpen ? 'rotate(90deg)' : undefined }}
                          aria-hidden
                        />
                      </td>
                      <td className="small muted" title={exact(a.created_at)}>
                        {ago(a.created_at)}
                      </td>
                      <td>
                        <AgentBadge name={a.actor_id ?? 'system'} />
                      </td>
                      <td>
                        <span className="chip">{a.operation}</span>
                      </td>
                      <td className="mono small">
                        {t?.memoryId ? (
                          <button
                            className="btn ghost sm"
                            style={{ padding: 0 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              openMemory(t.memoryId!);
                            }}
                          >
                            {t.memoryId}
                          </button>
                        ) : (
                          (t?.type ?? '')
                        )}
                      </td>
                      <td>
                        <span
                          className={`chip s`}
                          style={{
                            ['--c' as string]:
                              a.result === 'error'
                                ? 'var(--s-stale)'
                                : a.result === 'queued'
                                  ? 'var(--s-proposed)'
                                  : 'var(--s-confirmed)',
                          }}
                        >
                          {a.result}
                        </span>
                      </td>
                      <td className="mono small">{a.latency_ms !== null ? `${a.latency_ms} ms` : ''}</td>
                      <td className="mono small">
                        {a.request_id ? (
                          <>
                            {a.request_id.slice(0, 10)}
                            <CopyButton value={a.request_id} />
                          </>
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>,
                    isOpen && (
                      <tr key={`${a.id}x`}>
                        <td />
                        <td colSpan={7}>
                          <pre className="code small" style={{ margin: 0 }}>
                            {JSON.stringify(
                              { target: a.target, detail: a.detail, at: a.created_at },
                              null,
                              2,
                            )}
                          </pre>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <Button onClick={more}>Load more</Button>
          </div>
        )}
        <div className="small faint" style={{ padding: '8px 16px' }}>
          Showing recent activity retained on your plan.
        </div>
      </Card>
    </div>
  );
}
