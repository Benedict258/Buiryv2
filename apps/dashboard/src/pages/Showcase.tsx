import { useParams } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { api } from '../lib/api';
import { useQuery } from '../lib/app';
import { isNotShared } from '../lib/guard';
import { ago, dateOnly, typeLabel } from '../lib/format';
import { STATUSES, type Evidence, type MemType, type Status } from '../lib/types';
import {
  Async,
  Banner,
  Card,
  ConfidenceMeter,
  CopyButton,
  EvidenceChip,
  Stat,
  StackBar,
  StatusChip,
  TypeChip,
  Untrusted,
} from '../components/ui';

interface ShowcaseData {
  project: { id: string; name: string; networks: string[] };
  shows: string[];
  generatedAt: string;
  counts?: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
  memories?: {
    id: string;
    type: MemType;
    text: string;
    confidence: number;
    branch: string;
    createdAt: string;
    evidence?: { kind: string; label: string; result: string }[];
    blobId?: string | null;
    expiresAt?: string | null;
  }[];
  storage?: { storedMemories: number; soonestExpiry: string | null; mode: string };
}

const COLOR: Record<string, string> = {
  proposed: 'var(--s-proposed)',
  confirmed: 'var(--s-confirmed)',
  contested: 'var(--s-contested)',
  stale: 'var(--s-stale)',
};

/** The read-only public page of a project whose owner enabled the showcase. No sign-in, no sidebar. */
export function Showcase() {
  const { pid } = useParams();
  const q = useQuery(() => api<ShowcaseData>(`/v1/public/showcase/${pid}`), [pid], { refreshMs: 30_000 });
  const url = window.location.href;
  const notShared = isNotShared(q.error, q.data !== undefined);
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <Banner kind="info">
        <span className="row">
          <Globe size={14} aria-hidden /> Public view. This page shows only what the project owner chose to
          share{q.data ? ': ' + q.data.shows.join(', ') : ''}. It is read-only.
        </span>
      </Banner>
      {!notShared && (
        <Async q={q} rows={4} empty={null}>
          {(d) => (
            <>
              <div className="page-head mt">
                <div>
                  <h1>{d.project.name}</h1>
                  <p className="row wrap">
                    {d.project.networks.map((n) => (
                      <span key={n} className="chip">
                        {n}
                      </span>
                    ))}
                    <span className="faint small">updated {ago(d.generatedAt)}</span>
                  </p>
                </div>
                <div className="row">
                  <CopyButton value={url} label="Copy link" />
                  <span className="small muted">Copy link</span>
                </div>
              </div>

              {d.counts && (
                <div className="grid g4">
                  <Stat label="Memories" value={d.counts.total} />
                  {STATUSES.filter((s) => d.counts!.byStatus[s]).map((s) => (
                    <Stat key={s} label={s} value={d.counts!.byStatus[s]} />
                  ))}
                </div>
              )}
              {d.counts && (
                <Card title="By type" className="mt">
                  <div className="col">
                    {Object.entries(d.counts.byType).map(([t, n]) => {
                      const maxType = Math.max(...Object.values(d.counts!.byType));
                      return (
                        <div className="hbar" key={t}>
                          <span className="lab small">{typeLabel(t)}</span>
                          <div className="grow">
                            <StackBar
                              parts={[
                                { label: t, value: n, color: COLOR.confirmed! },
                                { label: 'rest', value: maxType - n, color: 'transparent' },
                              ]}
                            />
                          </div>
                          <span className="mono small">{n}</span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              {d.storage && (
                <Card title="Storage" className="mt">
                  <div className="row wrap" style={{ gap: 24 }}>
                    <span>Stored memories: {d.storage.storedMemories}</span>
                    <span>Mode: {d.storage.mode}</span>
                    <span>
                      Soonest expiry:{' '}
                      {d.storage.soonestExpiry ? dateOnly(d.storage.soonestExpiry) : 'unknown'}
                    </span>
                  </div>
                </Card>
              )}

              {d.memories && (
                <Card title="Confirmed memories" className="mt" flush>
                  <div style={{ padding: '0 16px' }}>
                    <Untrusted />
                  </div>
                  {d.memories.length === 0 ? (
                    <p className="muted small" style={{ padding: 16 }}>
                      No confirmed memories yet.
                    </p>
                  ) : (
                    d.memories.map((m) => (
                      <div
                        key={m.id}
                        className="col"
                        style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}
                      >
                        <div className="row wrap">
                          <StatusChip status={'confirmed' as Status} />
                          <TypeChip type={m.type} />
                          <ConfidenceMeter value={m.confidence} />
                          <span className="faint small">{ago(m.createdAt)}</span>
                        </div>
                        <p className="pre">{m.text}</p>
                        {m.evidence && m.evidence.length > 0 && (
                          <div className="row wrap">
                            {m.evidence.map((e, i) => (
                              <EvidenceChip
                                key={i}
                                e={
                                  {
                                    kind: e.kind,
                                    id: e.label,
                                    digest: e.label,
                                    path: e.label,
                                    href: e.label,
                                    name: e.label,
                                  } as Evidence
                                }
                                result={
                                  e.result === 'verified'
                                    ? 'pass'
                                    : e.result === 'failed'
                                      ? 'fail'
                                      : undefined
                                }
                              />
                            ))}
                          </div>
                        )}
                        {m.blobId && <span className="mono small faint">blob {m.blobId}</span>}
                      </div>
                    ))
                  )}
                </Card>
              )}
            </>
          )}
        </Async>
      )}
      {notShared && (
        <div className="empty" role="alert">
          <h3>Nothing is shared here</h3>
          <p className="muted">This project is private, or the link is wrong.</p>
        </div>
      )}
    </div>
  );
}
