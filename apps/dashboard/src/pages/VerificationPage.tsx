import { useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago, when } from '../lib/format';
import type { Evidence, Verification } from '../lib/types';
import {
  Async,
  Banner,
  Button,
  Card,
  EvidenceChip,
  Empty,
  Field,
  Modal,
  PageHead,
  Segmented,
  Stat,
  StackBar,
  Usage,
} from '../components/ui';

interface VerifyOut {
  results: {
    evidence: Evidence;
    result: string;
    detail: string;
    degraded: boolean;
    observed?: Record<string, unknown>;
  }[];
  extracted?: Evidence[];
}

export function VerificationPage() {
  const { projectId, openMemory } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const q = useQuery(() => api<Verification>(`/v1/projects/${projectId}/verification`), [projectId], {
    live: true,
  });
  const [rf, setRf] = useState<'all' | 'pass' | 'fail' | 'unchecked'>('all');
  const [kf, setKf] = useState('');
  const [tx, setTx] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const writer = can(role, 'writer');
  const reverify = async (memoryId: string, id: string) => {
    setBusy(id);
    try {
      await api(`/v1/projects/${projectId}/verifications`, { method: 'POST', body: { memoryId } });
      q.reload();
      bump();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const connectivity = async () => {
    setTest('Running…');
    try {
      const r = await api<VerifyOut>(`/v1/projects/${projectId}/verifications`, {
        method: 'POST',
        body: { evidence: { kind: 'object', id: '0x6', network: q.data?.networks[0] ?? 'sui:mainnet' } },
      });
      setTest(`${r.results[0]?.result}: ${r.results[0]?.detail}`);
      q.reload();
    } catch (e) {
      setTest((e as Error).message);
    }
  };
  return (
    <div className="page wide">
      <PageHead
        title="Verification"
        desc="The chain-verification subsystem at work, and a place to run checks."
      >
        <Button icon={<ShieldCheck size={14} />} onClick={() => setTx(true)} disabled={!writer}>
          Verify a transaction
        </Button>
      </PageHead>
      <Async q={q} rows={6}>
        {(v) => {
          const g = v.gateway;
          const hours = [...new Set(v.usage.hourly.map((h) => h.hour))].sort();
          const at = (hour: string, tr: string) =>
            v.usage.hourly
              .filter((h) => h.hour === hour && h.transport === tr)
              .reduce((a, h) => a + h.calls, 0);
          const hourly = hours.map((hour) => ({
            hour,
            grpc: at(hour, 'grpc'),
            jsonrpc: at(hour, 'jsonrpc'),
            cache: at(hour, 'cache'),
          }));
          const maxH = Math.max(1, ...hourly.map((h) => h.grpc + h.jsonrpc + h.cache));
          const ev = v.evidence.filter((e) => (rf === 'all' || e.result === rf) && (!kf || e.kind === kf));
          return (
            <>
              {!g.configured && (
                <Banner kind="warning">
                  The chain gateway is not configured. Evidence checks stay unknown until a Tatum key is set.
                </Banner>
              )}
              {g.configured && g.state !== 'ok' && (
                <Banner kind="warning">
                  Chain checks are unavailable. Existing results are shown with their age.
                </Banner>
              )}
              <div className="grid g4 mt">
                <Stat
                  label="Gateway"
                  value={
                    <span className="row">
                      <i className={`live-dot ${g.state === 'ok' ? 'on' : 'retry'}`} />
                      {g.state}
                    </span>
                  }
                  sub={`${v.networks.join(', ') || 'no networks'}`}
                />
                <Stat
                  label="Latency"
                  value={`${Math.round(g.latencyP50)} / ${Math.round(g.latencyP95)} ms`}
                  sub="p50 / p95"
                />
                <Stat
                  label="Error rate"
                  value={`${(g.errorRate * 100).toFixed(1)}%`}
                  sub={`${g.calls} calls`}
                />
                <Stat label="Transport mix" value="">
                  <StackBar
                    parts={[
                      { label: 'gRPC', value: g.transportMix.grpc ?? 0, color: 'var(--brand)' },
                      { label: 'JSON-RPC', value: g.transportMix.jsonrpc ?? 0, color: 'var(--s-proposed)' },
                      { label: 'cache', value: g.transportMix.cache ?? 0, color: 'var(--s-superseded)' },
                    ]}
                  />
                  <div className="small muted mt-s">
                    gRPC {g.transportMix.grpc ?? 0} · JSON-RPC {g.transportMix.jsonrpc ?? 0} · cache{' '}
                    {g.transportMix.cache ?? 0}
                  </div>
                </Stat>
              </div>
              <div className="row mt">
                <Button onClick={connectivity}>Run connectivity test</Button>
                {test && (
                  <span className="small muted" role="status">
                    {test}
                  </span>
                )}
              </div>
              <div className="grid g2 mt">
                <Card title="Usage by hour">
                  {hourly.length === 0 ? (
                    <Empty text="No gateway calls recorded yet." />
                  ) : (
                    <div
                      className="row"
                      style={{ alignItems: 'flex-end', height: 90, gap: 2 }}
                      role="img"
                      aria-label="Calls per hour split by transport"
                    >
                      {hourly.map((h) => (
                        <div
                          key={h.hour}
                          title={`${h.hour}: gRPC ${h.grpc}, JSON-RPC ${h.jsonrpc}, cache ${h.cache}`}
                          style={{
                            flex: 1,
                            maxWidth: 40,
                            display: 'flex',
                            flexDirection: 'column-reverse',
                            height: '100%',
                          }}
                        >
                          <i style={{ height: `${(h.grpc / maxH) * 100}%`, background: 'var(--brand)' }} />
                          <i
                            style={{
                              height: `${(h.jsonrpc / maxH) * 100}%`,
                              background: 'var(--s-proposed)',
                            }}
                          />
                          <i
                            style={{
                              height: `${(h.cache / maxH) * 100}%`,
                              background: 'var(--s-superseded)',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt">
                    {v.credits ? (
                      <>
                        <Usage used={v.credits.used} limit={v.credits.budget} label="Credits" />
                        <div className="small muted mt-s">
                          {v.credits.used} of {v.credits.budget} credits used
                        </div>
                      </>
                    ) : (
                      <div className="small muted">~{g.creditsEstimated} credits estimated this period</div>
                    )}
                  </div>
                </Card>
                <Card title="Top methods" flush>
                  {v.usage.byMethod.length === 0 ? (
                    <Empty text="No calls yet." />
                  ) : (
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Method</th>
                          <th>Transport</th>
                          <th>Calls</th>
                          <th>Avg latency</th>
                          <th>Errors</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.usage.byMethod.map((m) => (
                          <tr key={m.method}>
                            <td className="mono">{m.method}</td>
                            <td>{m.transport}</td>
                            <td>{m.calls}</td>
                            <td>{Math.round(m.avgLatencyMs)} ms</td>
                            <td>{m.errors}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
              <Card
                title="Evidence"
                className="mt"
                flush
                actions={
                  <span className="row">
                    <Segmented
                      label="Result"
                      value={rf}
                      onChange={setRf}
                      items={[
                        { id: 'all', label: 'All' },
                        { id: 'pass', label: 'Verified' },
                        { id: 'fail', label: 'Failed' },
                        { id: 'unchecked', label: 'Unchecked' },
                      ]}
                    />
                    <select
                      className="inp"
                      style={{ width: 'auto' }}
                      aria-label="Kind"
                      value={kf}
                      onChange={(e) => setKf(e.target.value)}
                    >
                      <option value="">All kinds</option>
                      {['tx', 'object', 'package', 'file', 'url', 'test'].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </span>
                }
              >
                {v.evidence.length === 0 ? (
                  <Empty text="No evidence yet. Evidence is a transaction, object, package, file or test that backs a memory. Agents attach it when they record one." />
                ) : ev.length === 0 ? (
                  <Empty text="No evidence matches these filters." />
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl cards">
                      <thead>
                        <tr>
                          <th>Evidence</th>
                          <th>Network</th>
                          <th>Memory</th>
                          <th>Last verified</th>
                          <th>Next check</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {ev.map((e) => (
                          <tr key={e.id}>
                            <td>
                              <EvidenceChip
                                e={e.ref}
                                result={e.result === 'unchecked' ? undefined : e.result}
                              />
                            </td>
                            <td className="mono small">{e.network ?? '—'}</td>
                            <td>
                              <button
                                className="btn ghost sm"
                                style={{ padding: 0 }}
                                onClick={() => openMemory(e.memoryId)}
                              >
                                {e.memoryId.slice(0, 14)}…
                              </button>
                            </td>
                            <td className="small muted">{ago(e.lastVerifiedAt)}</td>
                            <td className="small muted">{when(e.nextCheckAt)}</td>
                            <td>
                              <Button
                                size="sm"
                                icon={<RefreshCw size={12} />}
                                loading={busy === e.id}
                                disabled={!writer || e.kind === 'file'}
                                title={
                                  e.kind === 'file'
                                    ? 'File evidence is checked by the CLI against your repository'
                                    : undefined
                                }
                                onClick={() => reverify(e.memoryId, e.id)}
                              >
                                Re-verify
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </Async>
      {tx && (
        <TxModal
          onClose={() => setTx(false)}
          onCreated={() => {
            q.reload();
            bump();
          }}
        />
      )}
    </div>
  );
}

function TxModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { projectId } = useProject();
  const { toast } = useApp();
  const [digest, setDigest] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<VerifyOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      large
      title="Verify a transaction"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {out && out.results[0]?.result === 'pass' && (
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  const ev = [{ kind: 'tx', digest: digest.trim() }, ...(out.extracted ?? [])];
                  await api(`/v1/projects/${projectId}/memories`, {
                    method: 'POST',
                    body: {
                      text: `Deployment recorded from transaction ${digest.trim()}.`,
                      type: 'deployment',
                      evidence: ev,
                    },
                  });
                  toast('success', 'Deployment memory created.');
                  onCreated();
                  onClose();
                } catch (e) {
                  toast('error', (e as Error).message);
                }
              }}
            >
              Create deployment memory from this
            </Button>
          )}
        </>
      }
    >
      <Field label="Transaction digest">
        {(id) => (
          <input
            id={id}
            className="inp mono"
            value={digest}
            onChange={(e) => setDigest(e.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Button
        loading={busy}
        disabled={!digest.trim()}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          setOut(null);
          try {
            setOut(
              await api<VerifyOut>(`/v1/projects/${projectId}/verifications`, {
                method: 'POST',
                body: { evidence: { kind: 'tx', digest: digest.trim() } },
              }),
            );
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Fetch and verify
      </Button>
      {err && <Banner kind="error">{err}</Banner>}
      {out && (
        <div className="col">
          <Banner kind={out.results[0]?.result === 'pass' ? 'success' : 'warning'}>
            {out.results[0]?.result}: {out.results[0]?.detail}
            {out.results[0]?.degraded ? ' (gateway degraded)' : ''}
          </Banner>
          {out.extracted && out.extracted.length > 0 && (
            <div>
              <div className="label">Identifiers found in the transaction</div>
              <div className="row wrap mt-s">
                {out.extracted.map((e, i) => (
                  <EvidenceChip key={i} e={e} />
                ))}
              </div>
            </div>
          )}
          {out.results[0]?.observed && (
            <pre className="code small">{JSON.stringify(out.results[0].observed, null, 2)}</pre>
          )}
        </div>
      )}
    </Modal>
  );
}
