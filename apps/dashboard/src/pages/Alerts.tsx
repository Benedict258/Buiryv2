import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XOctagon } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago } from '../lib/format';
import type { AlertRule, Flag } from '../lib/types';
import { Async, Banner, Button, Card, Drawer, Empty, Field, Modal, PageHead, Tabs } from '../components/ui';

const SEV = {
  critical: [XOctagon, 'var(--s-stale)'],
  warning: [AlertTriangle, 'var(--s-contested)'],
  info: [Info, 'var(--s-proposed)'],
} as const;
const EVENTS = [
  'memory.stale',
  'memory.contested',
  'memory.expiring',
  'write.failed',
  'flag.created',
  'storage.degraded',
  'verification.degraded',
];

export function Alerts() {
  const { projectId, openMemory } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const [tab, setTab] = useState<'open' | 'acknowledged' | 'resolved' | 'rules'>('open');
  const q = useQuery(() => api<Flag[]>(`/v1/projects/${projectId}/flags`), [projectId], { live: true });
  const rules = useQuery(() => api<AlertRule[]>(`/v1/projects/${projectId}/alert-rules`), [projectId]);
  const [sel, setSel] = useState<Flag | null>(null);
  const [newRule, setNewRule] = useState(false);
  const writer = can(role, 'writer');
  const set = async (f: Flag, a: 'acknowledge' | 'resolve') => {
    try {
      await api(`/v1/flags/${f.id}/${a}`, { method: 'POST', body: {} });
      toast('success', a === 'acknowledge' ? 'Acknowledged.' : 'Resolved.');
      q.reload();
      bump();
      setSel(null);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  const all = q.data ?? [];
  const count = (s: string) => all.filter((f) => f.state === s).length;
  return (
    <div className="page">
      <PageHead title="Alerts" desc="Act on stale, contested, expiring and failed items." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'open', label: 'Open', n: count('open') },
          { id: 'acknowledged', label: 'Acknowledged', n: count('acknowledged') },
          { id: 'resolved', label: 'Resolved', n: count('resolved') },
          { id: 'rules', label: 'Rules', n: rules.data?.length },
        ]}
      />
      {tab !== 'rules' ? (
        <Async q={q} rows={3}>
          {() => {
            const list = all.filter((f) => f.state === tab);
            if (list.length === 0)
              return (
                <Empty
                  icon={<CheckCircle2 size={28} />}
                  text={tab === 'open' ? 'Nothing needs attention.' : `No ${tab} alerts.`}
                />
              );
            return (['critical', 'warning', 'info'] as const).map((sev) => {
              const g = list.filter((f) => f.severity === sev);
              if (!g.length) return null;
              const [Icon, color] = SEV[sev];
              return (
                <section key={sev} className="mt">
                  <h4 className="row" style={{ marginBottom: 8, textTransform: 'capitalize' }}>
                    <Icon size={16} style={{ color }} aria-hidden />
                    {sev} <span className="chip">{g.length}</span>
                  </h4>
                  <div className="col">
                    {g.map((f) => (
                      <div key={f.id} className="card row" style={{ alignItems: 'flex-start' }}>
                        <button
                          className="grow btn ghost"
                          style={{ textAlign: 'left', whiteSpace: 'normal', display: 'block', padding: 0 }}
                          onClick={() => setSel(f)}
                        >
                          <strong>{titleOf(f)}</strong>
                          <div className="small muted">{f.detail}</div>
                          <div className="small faint">
                            first seen {ago(f.first_seen)} · last seen {ago(f.last_seen)}
                          </div>
                        </button>
                        <div className="row wrap">
                          {f.memory_id && (
                            <Button size="sm" onClick={() => openMemory(f.memory_id!)}>
                              Open memory
                            </Button>
                          )}
                          {f.state === 'open' && (
                            <Button size="sm" disabled={!writer} onClick={() => set(f, 'acknowledge')}>
                              Acknowledge
                            </Button>
                          )}
                          {f.state !== 'resolved' && (
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!writer}
                              onClick={() => set(f, 'resolve')}
                            >
                              Resolve
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            });
          }}
        </Async>
      ) : (
        <Card
          flush
          actions={
            <Button size="sm" disabled={!can(role, 'admin')} onClick={() => setNewRule(true)}>
              New rule
            </Button>
          }
          title="Alert rules"
        >
          <Async q={rules} rows={2}>
            {(r) =>
              r.length === 0 ? (
                <Empty text="No custom rules. Default alerts appear on the dashboard." />
              ) : (
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Min severity</th>
                      <th>Channel</th>
                      <th>Quiet hours</th>
                      <th>Grouping</th>
                      <th>Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.map((x) => (
                      <tr key={x.id}>
                        <td className="mono">{x.event}</td>
                        <td>{x.minSeverity ?? 'info'}</td>
                        <td>{x.channel ?? 'dashboard'}</td>
                        <td>
                          {x.quietHours
                            ? `${x.quietHours.startHour}:00 to ${x.quietHours.endHour}:00`
                            : 'none'}
                        </td>
                        <td>{x.grouping ? 'on' : 'off'}</td>
                        <td>
                          <input
                            type="checkbox"
                            checked={x.enabled !== false}
                            disabled={!can(role, 'admin')}
                            aria-label={`Enable ${x.event}`}
                            onChange={async (e) => {
                              await api(`/v1/projects/${projectId}/alert-rules`, {
                                method: 'PUT',
                                body: { ...x, enabled: e.target.checked },
                              }).catch((er) => toast('error', er.message));
                              rules.reload();
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </Async>
        </Card>
      )}
      <Drawer
        open={!!sel}
        onClose={() => setSel(null)}
        header={<strong>{sel ? titleOf(sel) : ''}</strong>}
        footer={
          sel && (
            <>
              {sel.state === 'open' && (
                <Button disabled={!writer} onClick={() => set(sel, 'acknowledge')}>
                  Acknowledge
                </Button>
              )}
              {sel.state !== 'resolved' && (
                <Button variant="primary" disabled={!writer} onClick={() => set(sel, 'resolve')}>
                  Resolve
                </Button>
              )}
            </>
          )
        }
      >
        {sel && (
          <div className="col">
            <Banner
              kind={sel.severity === 'critical' ? 'error' : sel.severity === 'warning' ? 'warning' : 'info'}
            >
              {sel.detail}
            </Banner>
            <div className="small muted">
              Kind: <span className="mono">{sel.kind}</span> · state {sel.state}
            </div>
            {sel.memory_id && (
              <div>
                <div className="label">Affected memory</div>
                <Button
                  className="mt-s"
                  onClick={() => {
                    openMemory(sel.memory_id!);
                    setSel(null);
                  }}
                >
                  Open {sel.memory_id}
                </Button>
              </div>
            )}
          </div>
        )}
      </Drawer>
      <RuleModal
        open={newRule}
        onClose={() => {
          setNewRule(false);
          rules.reload();
        }}
      />
    </div>
  );
}
const titleOf = (f: Flag) =>
  (
    ({
      stale: 'Memory went stale',
      possible_conflict: 'Possible conflict between memories',
      contested: 'Memory contested',
      expiring: 'Memories are expiring',
      failed_write: 'A write failed',
    }) as Record<string, string>
  )[f.kind] ?? f.kind.replace(/_/g, ' ');

function RuleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { projectId } = useProject();
  const { toast } = useApp();
  const [event, setEvent] = useState(EVENTS[0]!);
  const [sev, setSev] = useState('warning');
  const [quiet, setQuiet] = useState(false);
  const [group, setGroup] = useState(true);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New alert rule"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api(`/v1/projects/${projectId}/alert-rules`, {
                  method: 'PUT',
                  body: {
                    event,
                    minSeverity: sev,
                    channel: 'dashboard',
                    grouping: group,
                    enabled: true,
                    quietHours: quiet ? { startHour: 22, endHour: 7 } : null,
                  },
                });
                toast('success', 'Rule saved.');
                onClose();
              } catch (e) {
                toast('error', (e as Error).message);
              }
            }}
          >
            Save rule
          </Button>
        </>
      }
    >
      <Field label="Event">
        {(id) => (
          <select id={id} className="inp" value={event} onChange={(e) => setEvent(e.target.value)}>
            {EVENTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Minimum severity">
        {(id) => (
          <select id={id} className="inp" value={sev} onChange={(e) => setSev(e.target.value)}>
            <option>info</option>
            <option>warning</option>
            <option>critical</option>
          </select>
        )}
      </Field>
      <label className="check">
        <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
        Quiet hours 22:00 to 07:00
      </label>
      <label className="check">
        <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
        Group similar alerts
      </label>
      <p className="small muted">Webhook destinations are configured under Integrations.</p>
    </Modal>
  );
}
