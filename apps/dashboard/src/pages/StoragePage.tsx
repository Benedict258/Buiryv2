import { useState } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago, dateOnly, plural } from '../lib/format';
import type { Storage, StatusOut } from '../lib/types';
import { StorageAccountCard } from './StorageAccount';
import {
  Async,
  Banner,
  Button,
  Card,
  ExpiryIndicator,
  PageHead,
  Stat,
  Empty,
  ErrorBlock,
} from '../components/ui';

export function StoragePage() {
  const { projectId, openMemory, status, base } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const q = useQuery(() => api<Storage>(`/v1/projects/${projectId}/storage`), [projectId], {
    live: true,
    refreshMs: 20_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const renew = async () => {
    setBusy('renew');
    try {
      const r = await api<{ queued: string[]; failed: { memoryId: string; reason: string }[] }>(
        `/v1/projects/${projectId}/storage/renew`,
        { method: 'POST', body: { memoryIds: [...picked] } },
      );
      toast(
        r.failed.length ? 'info' : 'success',
        `${plural(r.queued.length, 'memory')} queued for renewal${r.failed.length ? `; ${r.failed.length} could not be: ${r.failed[0]!.reason}` : ''}.`,
      );
      setPicked(new Set());
      q.reload();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const s: StatusOut | undefined = status.data;
  const retry = async (id: string) => {
    setBusy(id);
    try {
      await api(`/v1/writes/${id}/retry`, { method: 'POST', body: {} });
      toast('success', 'Write queued again.');
      q.reload();
      bump();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page wide">
      <PageHead
        title="Storage health"
        desc="Persistence made visible: where memory lives, how long it lasts, and what failed."
      />
      <div className="grid g4">
        <Stat
          label="Relayer"
          value={
            <span className="row">
              <i
                className={`live-dot ${s?.relayer.state === 'ok' ? 'on' : s?.relayer.state === 'unknown' ? 'off' : 'retry'}`}
              />
              {s?.relayer.state ?? '…'}
            </span>
          }
          sub={s?.relayer.version ? `version ${s.relayer.version}` : 'No probe result yet'}
          loading={status.loading}
        />
        <Stat
          label="Write queue"
          value={(s?.queue.queued ?? 0) + (s?.queue.submitting ?? 0) + (s?.queue.submitted ?? 0)}
          sub={`oldest ${s ? Math.round(s.queue.oldestPendingAgeMs / 1000) : 0}s · ${s?.queue.dead ?? 0} failed`}
          loading={status.loading}
        />
        <Stat
          label="Stored writes"
          value={s?.queue.stored ?? 0}
          sub="events written to Walrus"
          loading={status.loading}
        />
        <Stat
          label="Soonest expiry"
          value={s?.expiry.soonest ? dateOnly(s.expiry.soonest) : 'unknown'}
          sub={`${s?.expiry.expiring ?? 0} expiring · ${s?.expiry.expired ?? 0} expired`}
          loading={status.loading}
        />
      </div>
      {s && ['degraded', 'paused', 'unreachable'].includes(s.relayer.state) && (
        <div className="mt">
          <Banner kind="warning">
            Storage is slow or unavailable. New memories are queued and reads come from cache.
          </Banner>
        </div>
      )}

      <Async q={q} rows={6}>
        {(d) => (
          <>
            <Card
              title="Expiry"
              className="mt"
              flush
              actions={
                <span className="row">
                  <Button
                    size="sm"
                    loading={busy === 'renew'}
                    disabled={!d.renewal?.enabled || picked.size === 0 || !can(role, 'writer')}
                    title={
                      d.renewal?.enabled
                        ? 'Writes the selected memories again before they expire'
                        : 'Renewal is turned off on this deployment (BUIRY_RENEWAL)'
                    }
                    onClick={renew}
                  >
                    Renew selected{picked.size ? ` (${picked.size})` : ''}
                  </Button>
                  <a className="btn sm" href={`${base}/packs`}>
                    <Download size={12} /> Export
                  </a>
                </span>
              }
            >
              <p className="small muted" style={{ padding: '0 16px' }}>
                Stored memories last for the period paid for. Buiry alerts you before they lapse
                {d.renewal?.enabled
                  ? ' and, when renewal is on, writes them again before they do; the old copy stays until the new one is stored.'
                  : '.'}
              </p>
              {d.expiry.length === 0 ? (
                <Empty text="No stored memories yet. Expiry is checked once they are written." />
              ) : (
                <div className="tbl-wrap">
                  <table className="tbl cards">
                    <thead>
                      <tr>
                        <th aria-label="Select" />
                        <th>Memory</th>
                        <th>Expires</th>
                        <th>Remaining</th>
                        <th>Renewal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...d.expiry]
                        .sort((a, b) => (a.expiresAt ?? '9').localeCompare(b.expiresAt ?? '9'))
                        .map((e) => (
                          <tr key={e.memoryId} className="click" onClick={() => openMemory(e.memoryId)}>
                            <td onClick={(ev) => ev.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label="Select for renewal"
                                disabled={!d.renewal?.enabled || e.expired || e.renewalPending}
                                checked={picked.has(e.memoryId)}
                                onChange={() => toggle(e.memoryId)}
                              />
                            </td>
                            <td style={{ maxWidth: 420 }}>
                              <div className="clamp2">{e.text}</div>
                            </td>
                            <td className="mono small">{dateOnly(e.expiresAt)}</td>
                            <td>
                              <ExpiryIndicator expiresAt={e.expiresAt} expired={e.expired} />
                            </td>
                            <td className="small muted">
                              {e.renewalPending
                                ? 'Renewal queued'
                                : e.renewalGeneration
                                  ? `Renewed ${plural(e.renewalGeneration, 'time')}`
                                  : d.renewal?.enabled
                                    ? 'Not renewed'
                                    : 'Off'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <div className="grid g2 mt">
              <StorageAccountCard storedMemories={d.storedMemories} onChange={() => q.reload()} />
              <Card title="Deletion options">
                <div className="col small">
                  <div>
                    <strong>Tombstone.</strong> {d.deletion.tombstone}
                  </div>
                  <div>
                    <strong>Index removal.</strong> {d.deletion.indexRemoval}
                  </div>
                  <div>
                    <strong>Permanent deletion.</strong> {d.deletion.permanentDeletion}
                  </div>
                </div>
              </Card>
            </div>
            <Card title={`Failed writes (${d.deadLetters.length})`} className="mt" flush>
              {d.deadLetters.length === 0 ? (
                <Empty text="No failed writes." />
              ) : (
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th>Memory</th>
                      <th>Error</th>
                      <th>Attempts</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.deadLetters.map((j) => (
                      <tr key={j.id}>
                        <td className="mono small">{j.memory_id}</td>
                        <td className="small">{j.last_error ?? 'unknown'}</td>
                        <td>{plural(j.attempts, 'attempt')}</td>
                        <td>
                          <Button
                            size="sm"
                            icon={<RotateCw size={12} />}
                            loading={busy === j.id}
                            disabled={!can(role, 'writer')}
                            onClick={() => retry(j.id)}
                          >
                            Retry
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}
      </Async>
      {q.error && !q.data && <ErrorBlock error={q.error} retry={q.reload} />}
      <p className="faint small mt">Last checked {ago(new Date().toISOString())}.</p>
    </div>
  );
}
