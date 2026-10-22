import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useWs } from '../lib/ctx';
import { ago, plural, when } from '../lib/format';
import type { Billing as BillingT, Flag, Member, Role } from '../lib/types';
import {
  Async,
  Banner,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  Drawer,
  Empty,
  Field,
  Modal,
  PageHead,
  Tabs,
  TokenReveal,
  Usage,
  cx,
} from '../components/ui';

/* ---------------- Team ---------------- */
const MATRIX: [string, boolean, boolean, boolean, boolean][] = [
  ['Read memories, briefings, activity', true, true, true, true],
  ['Record memories, report outcomes', false, true, true, true],
  ['Confirm and withdraw memories', false, false, true, true],
  ['Manage agents, tokens, settings', false, false, true, true],
  ['Invite members, change roles', false, false, true, true],
  ['Archive projects, manage billing', false, false, false, true],
];

export function Team() {
  const { wsId, role } = useWs();
  const { me, toast } = useApp();
  const [tab, setTab] = useState<'members' | 'invitations'>('members');
  const q = useQuery(() => api<Member[]>(`/v1/workspaces/${wsId}/members`), [wsId]);
  const [invite, setInvite] = useState(false);
  const [matrix, setMatrix] = useState(false);
  const invites = useQuery(() => api<Invite[]>(`/v1/workspaces/${wsId}/invitations`), [wsId, tab]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const admin = can(role, 'admin');
  const changeRole = async (m: Member, r: string) => {
    try {
      await api(`/v1/workspaces/${wsId}/members/${m.user_id}`, { method: 'PATCH', body: { role: r } });
      toast('success', 'Role updated.');
      q.reload();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  return (
    <div className="page">
      <PageHead title="Team" desc="Who can do what in this workspace.">
        <Button onClick={() => setMatrix(true)}>What can each role do?</Button>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!admin}
          title={!admin ? 'You need Admin access to invite.' : undefined}
          onClick={() => setInvite(true)}
        >
          Invite
        </Button>
      </PageHead>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'members', label: 'Members', n: q.data?.length },
          { id: 'invitations', label: 'Invitations', n: invites.data?.length },
        ]}
      />
      {tab === 'members' ? (
        <Card flush>
          <Async q={q} rows={3}>
            {(rows) => (
              <>
                <div className="tbl-wrap">
                  <table className="tbl cards">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Role</th>
                        <th>Project access</th>
                        <th>Joined</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => (
                        <tr key={m.user_id}>
                          <td>
                            <span className="mono small">{m.user_id}</span>{' '}
                            {m.user_id === me?.id && <span className="chip">You</span>}
                          </td>
                          <td>
                            {m.role === 'owner' || !admin || m.user_id === me?.id ? (
                              <span className="chip">{m.role}</span>
                            ) : (
                              <select
                                className="inp"
                                style={{ width: 'auto' }}
                                aria-label="Role"
                                value={m.role}
                                onChange={(e) => changeRole(m, e.target.value)}
                              >
                                <option>admin</option>
                                <option>writer</option>
                                <option>reader</option>
                              </select>
                            )}
                          </td>
                          <td className="small muted">
                            {m.project_scope ? plural(m.project_scope.length, 'project') : 'All projects'}
                          </td>
                          <td className="small muted">{ago(m.created_at)}</td>
                          <td>
                            {admin && m.role !== 'owner' && m.user_id !== me?.id && (
                              <Button
                                size="sm"
                                variant="danger"
                                icon={<Trash2 size={12} />}
                                onClick={async () => {
                                  try {
                                    await api(`/v1/workspaces/${wsId}/members/${m.user_id}`, {
                                      method: 'DELETE',
                                    });
                                    toast('success', 'Member removed.');
                                    q.reload();
                                  } catch (e) {
                                    toast('error', (e as Error).message);
                                  }
                                }}
                              >
                                Remove
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length === 1 && (
                  <div style={{ padding: 16 }}>
                    <Empty text="You are the only member. Invite teammates to share project memory." />
                  </div>
                )}
              </>
            )}
          </Async>
        </Card>
      ) : (
        <Async q={invites} rows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty text="No open invitations." />
            ) : (
              <div className="col">
                {rows.map((x) => (
                  <Card key={x.id}>
                    <div className="spread">
                      <div>
                        {x.invitee} <span className="chip">{x.role}</span>{' '}
                        <span className="chip">
                          {x.state === 'expired' ? 'expired' : `expires ${when(x.expires_at)}`}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!admin}
                        onClick={async () => {
                          try {
                            await api(`/v1/workspaces/${wsId}/invitations/${x.id}`, { method: 'DELETE' });
                            toast('success', 'Invitation revoked.');
                            invites.reload();
                          } catch (e) {
                            toast('error', (e as Error).message);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                    {links[x.id] ? (
                      <div className="mt-s">
                        <div className="label">Invite link (shown once, copy it now)</div>
                        <CodeBlock value={`${window.location.origin}/invite/${links[x.id]}`} />
                      </div>
                    ) : (
                      <p className="small faint mt-s">
                        The link is only shown when the invitation is created. Revoke and invite again to get
                        a new one.
                      </p>
                    )}
                  </Card>
                ))}
              </div>
            )
          }
        </Async>
      )}
      <InviteModal
        open={invite}
        onClose={() => setInvite(false)}
        onSent={(i) => {
          setLinks((l) => ({ ...l, [i.id]: i.token }));
          setTab('invitations');
          invites.reload();
        }}
      />
      <Drawer open={matrix} onClose={() => setMatrix(false)} header={<strong>Role permissions</strong>}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Action</th>
              <th>Reader</th>
              <th>Writer</th>
              <th>Admin</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX.map(([a, ...r]) => (
              <tr key={a}>
                <td>{a}</td>
                {r.map((x, i) => (
                  <td key={i} aria-label={x ? 'allowed' : 'not allowed'}>
                    {x ? '✓' : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Drawer>
    </div>
  );
}

function InviteModal({
  open,
  onClose,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onSent: (i: { id: string; token: string }) => void;
}) {
  const { wsId } = useWs();
  const { toast } = useApp();
  const [invitee, setInvitee] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('writer');
  const [hours, setHours] = useState(168);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a teammate"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={invitee.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ id: string; token: string }>(`/v1/workspaces/${wsId}/invitations`, {
                  method: 'POST',
                  body: { invitee: invitee.trim(), role, expiresInHours: hours },
                });
                onSent({ id: r.id, token: r.token });
                toast('success', 'Invitation created.');
                setInvitee('');
                onClose();
              } catch (e) {
                toast('error', (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create invitation
          </Button>
        </>
      }
    >
      <Field label="Email or wallet address">
        {(id) => (
          <input
            id={id}
            className="inp"
            value={invitee}
            onChange={(e) => setInvitee(e.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field label="Role">
        {(id) => (
          <select
            id={id}
            className="inp"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option>admin</option>
            <option>writer</option>
            <option>reader</option>
          </select>
        )}
      </Field>
      <Field label="Expires in (hours)">
        {(id) => (
          <input
            id={id}
            className="inp"
            type="number"
            min={1}
            max={720}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          />
        )}
      </Field>
    </Modal>
  );
}

/* ---------------- Integrations ---------------- */
interface Invite {
  id: string;
  invitee: string;
  role: string;
  state: 'pending' | 'expired';
  expires_at: string;
  created_at: string;
}
interface Hook {
  id: string;
  name: string;
  kind: string;
  url: string;
  events: string[];
  status: string;
  paused_reason: string | null;
  project_id: string | null;
}
interface Delivery {
  id: string;
  event_type: string;
  state: string;
  attempts: number;
  status_code: number | null;
  duration_ms: number | null;
  last_error: string | null;
  created_at: string;
}
const HOOK_EVENTS = [
  'memory.created',
  'memory.stale',
  'memory.contested',
  'memory.superseded',
  'flag.created',
  'write.failed',
];

export function Integrations() {
  const { wsId, role } = useWs();
  const { toast } = useApp();
  const q = useQuery(() => api<Hook[]>(`/v1/workspaces/${wsId}/webhooks`), [wsId]);
  const [create, setCreate] = useState<'slack' | 'discord' | 'generic' | null>(null);
  const [sel, setSel] = useState<Hook | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const admin = can(role, 'admin');
  return (
    <div className="page">
      <PageHead title="Integrations" desc="Send alerts and events to Slack, Discord or any HTTPS endpoint." />
      <div className="grid g3">
        {(['slack', 'discord', 'generic'] as const).map((k) => (
          <Card key={k} title={k === 'generic' ? 'Generic webhook' : k[0]!.toUpperCase() + k.slice(1)}>
            <p className="small muted">
              {k === 'generic'
                ? 'Signed JSON events to your own endpoint.'
                : `Post alerts into a ${k} channel with an incoming webhook URL.`}
            </p>
            <div className="mt">
              <Button disabled={!admin} onClick={() => setCreate(k)}>
                Connect
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <Card title="Endpoints" flush className="mt">
        <Async q={q} rows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty text="No endpoints configured." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Events</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((h) => (
                      <tr key={h.id} className="click" onClick={() => setSel(h)}>
                        <td>{h.name}</td>
                        <td>
                          <span className="chip">{h.kind}</span>
                        </td>
                        <td className="small muted">{h.events.join(', ')}</td>
                        <td>
                          <span
                            className={cx('chip', h.status === 'active' && 's')}
                            style={
                              h.status === 'active'
                                ? { ['--c' as string]: 'var(--s-confirmed)' }
                                : { color: 'var(--s-contested)' }
                            }
                          >
                            {h.status}
                          </span>
                          {h.paused_reason && <div className="small muted">{h.paused_reason}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Card>
      {create && (
        <HookModal
          kind={create}
          onClose={() => setCreate(null)}
          onCreated={(s) => {
            setCreate(null);
            setSecret(s);
            q.reload();
          }}
        />
      )}
      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Signing secret"
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            Done
          </Button>
        }
      >
        {secret && (
          <TokenReveal
            token={secret}
            hint={<span className="small muted">Verify the Buiry-Signature header with this secret.</span>}
          />
        )}
      </Modal>
      {sel && (
        <HookDrawer
          h={sel}
          onClose={() => setSel(null)}
          onDeleted={() => {
            setSel(null);
            q.reload();
            toast('success', 'Endpoint deleted.');
          }}
        />
      )}
    </div>
  );
}
function HookModal({
  kind,
  onClose,
  onCreated,
}: {
  kind: 'slack' | 'discord' | 'generic';
  onClose: () => void;
  onCreated: (s: string) => void;
}) {
  const { wsId } = useWs();
  const { toast } = useApp();
  const [name, setName] = useState<string>(kind);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['memory.stale', 'flag.created']);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect ${kind}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!url || events.length === 0}
            onClick={async () => {
              try {
                const r = await api<{ secret: string }>(`/v1/workspaces/${wsId}/webhooks`, {
                  method: 'POST',
                  body: { name, kind, url, events },
                });
                onCreated(r.secret);
              } catch (e) {
                toast('error', (e as Error).message);
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <Field label="Name">
        {(id) => <input id={id} className="inp" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Destination URL" help="HTTPS only. Private network addresses are refused.">
        {(id) => (
          <input
            id={id}
            className="inp mono"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <div className="field">
        <span className="lab">Events</span>
        <div className="row wrap">
          {HOOK_EVENTS.map((e) => (
            <label key={e} className="check chip">
              <input
                type="checkbox"
                checked={events.includes(e)}
                onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))}
              />
              {e}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
function HookDrawer({ h, onClose, onDeleted }: { h: Hook; onClose: () => void; onDeleted: () => void }) {
  const { toast } = useApp();
  const q = useQuery(() => api<Delivery[]>(`/v1/webhooks/${h.id}/deliveries`), [h.id], { refreshMs: 5000 });
  const [del, setDel] = useState(false);
  return (
    <Drawer
      wide
      open
      onClose={onClose}
      header={
        <div className="col" style={{ gap: 2 }}>
          <strong>{h.name}</strong>
          <span className="mono small muted trunc">{h.url}</span>
        </div>
      }
      footer={
        <>
          <Button
            icon={<Send size={14} />}
            onClick={async () => {
              try {
                await api(`/v1/webhooks/${h.id}/test`, { method: 'POST', body: {} });
                toast('info', 'Test event queued.');
                q.reload();
              } catch (e) {
                toast('error', (e as Error).message);
              }
            }}
          >
            Send test
          </Button>
          <Button variant="danger" onClick={() => setDel(true)}>
            Delete
          </Button>
        </>
      }
    >
      {h.status !== 'active' && (
        <Banner kind="warning">Paused: {h.paused_reason ?? 'repeated delivery failures'}.</Banner>
      )}
      <div className="label mt">Delivery log</div>
      <Async q={q} rows={3}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty text="No deliveries yet." />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="small muted">{ago(d.created_at)}</td>
                    <td className="mono small">{d.event_type}</td>
                    <td>
                      {d.status_code ?? d.state}
                      {d.last_error && <div className="small muted">{d.last_error}</div>}
                    </td>
                    <td className="mono small">{d.duration_ms ?? ''}</td>
                    <td>
                      <Button
                        size="sm"
                        onClick={async () => {
                          await api(`/v1/deliveries/${d.id}/replay`, { method: 'POST', body: {} }).catch(
                            (e) => toast('error', e.message),
                          );
                          q.reload();
                        }}
                      >
                        Retry
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Async>
      <ConfirmModal
        open={del}
        onClose={() => setDel(false)}
        danger
        title="Delete endpoint"
        confirmLabel="Delete"
        body="Events stop being sent to this endpoint."
        onConfirm={async () => {
          await api(`/v1/webhooks/${h.id}`, { method: 'DELETE' });
          onDeleted();
        }}
      />
    </Drawer>
  );
}

/* ---------------- API tokens ---------------- */
interface Tok {
  id: string;
  name: string;
  scopes: string[];
  project_ids?: string[] | null;
  created_at: string;
  last_used_at: string | null;
  expires_at?: string | null;
}
export function ApiTokens() {
  const { wsId, role, projects } = useWs();
  const { toast } = useApp();
  const q = useQuery(() => api<Tok[]>(`/v1/workspaces/${wsId}/api-tokens`), [wsId]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [pids, setPids] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Tok | null>(null);
  const admin = can(role, 'admin');
  return (
    <div className="page">
      <PageHead title="API tokens" desc="For scripts and CI. Agents use their own tokens.">
        <Button variant="primary" icon={<Plus size={14} />} disabled={!admin} onClick={() => setOpen(true)}>
          Create token
        </Button>
      </PageHead>
      <Card flush>
        <Async q={q} rows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty text="No API tokens yet." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Scopes</th>
                      <th>Projects</th>
                      <th>Created</th>
                      <th>Last used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td>
                          <div className="row wrap">
                            {t.scopes.map((s) => (
                              <span key={s} className="chip">
                                {s}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="small muted">
                          {t.project_ids?.length ? plural(t.project_ids.length, 'project') : 'All'}
                        </td>
                        <td className="small muted">{ago(t.created_at)}</td>
                        <td className="small muted">{ago(t.last_used_at)}</td>
                        <td>
                          <Button size="sm" variant="danger" disabled={!admin} onClick={() => setRevoke(t)}>
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Card>
      <p className="small muted mt">See the API reference in the repository docs.</p>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create API token"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  const r = await api<{ token: string }>(`/v1/workspaces/${wsId}/api-tokens`, {
                    method: 'POST',
                    body: { name: name.trim(), scopes, ...(pids.length ? { projectIds: pids } : {}) },
                  });
                  setOpen(false);
                  setToken(r.token);
                  setName('');
                  q.reload();
                } catch (e) {
                  toast('error', (e as Error).message);
                }
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          {(id) => (
            <input id={id} className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          )}
        </Field>
        <div className="field">
          <span className="lab">Scopes</span>
          <div className="row wrap">
            {['read', 'write', 'admin'].map((s) => (
              <label key={s} className="check chip">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) =>
                    setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
                  }
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="lab">Projects (none selected means all)</span>
          <div className="row wrap">
            {projects.data?.map((p) => (
              <label key={p.id} className="check chip">
                <input
                  type="checkbox"
                  checked={pids.includes(p.id)}
                  onChange={(e) =>
                    setPids(e.target.checked ? [...pids, p.id] : pids.filter((x) => x !== p.id))
                  }
                />
                {p.name}
              </label>
            ))}
          </div>
        </div>
      </Modal>
      <Modal
        open={!!token}
        onClose={() => setToken(null)}
        title="Your new token"
        footer={
          <Button variant="primary" onClick={() => setToken(null)}>
            Done
          </Button>
        }
      >
        {token && <TokenReveal token={token} />}
      </Modal>
      <ConfirmModal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        danger
        title="Revoke token"
        confirmLabel="Revoke"
        body={`Anything using “${revoke?.name}” stops working immediately.`}
        onConfirm={async () => {
          await api(`/v1/api-tokens/${revoke!.id}`, { method: 'DELETE' });
          toast('success', 'Token revoked.');
          q.reload();
        }}
      />
    </div>
  );
}

/* ---------------- Billing ---------------- */
export function Billing() {
  const { wsId, plan } = useWs();
  const q = useQuery(() => api<BillingT>(`/v1/workspaces/${wsId}/billing`), [wsId]);
  const [cmp, setCmp] = useState(false);
  return (
    <div className="page">
      <PageHead title="Billing" desc="Plan, usage and invoices." />
      <Async q={q} rows={4}>
        {(b) => (
          <>
            <Card title="Current plan" actions={<Button onClick={() => setCmp(true)}>Compare plans</Button>}>
              <div className="row">
                <h2 style={{ textTransform: 'capitalize' }}>{b.plan}</h2>
                <span className="muted">Price: {b.prices}</span>
              </div>
            </Card>
            <Card title="Usage" className="mt">
              <div className="col">
                {Object.entries(b.limits).map(([k, limit]) => {
                  const used = b.usage[k] ?? 0;
                  return (
                    <div key={k}>
                      <div className="spread small">
                        <span style={{ textTransform: 'capitalize' }}>{k}</span>
                        <span className="mono">
                          {used} / {limit}
                        </span>
                      </div>
                      <Usage used={used} limit={limit} label={k} />
                      {used >= limit && (
                        <div className="small" style={{ color: 'var(--s-stale)' }}>
                          You have used {used} of {limit} {k} on the {plan} plan.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
            <div className="grid g2 mt">
              <Card title="Payment method">
                {b.paymentMethods.length === 0 ? (
                  <p className="small muted">No payment method. Card or Sui payments are not enabled yet.</p>
                ) : null}
              </Card>
              <Card title="Invoices">
                {b.invoices.length === 0 ? <p className="small muted">No invoices yet.</p> : null}
              </Card>
            </div>
          </>
        )}
      </Async>
      <Modal open={cmp} onClose={() => setCmp(false)} large title="Plans">
        <table className="tbl">
          <thead>
            <tr>
              <th />
              <th>Free</th>
              <th>Pro</th>
              <th>Team</th>
              <th>Enterprise</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Price', 'to be set', 'to be set', 'to be set', 'Contact us'],
              ['Projects', '3', 'more', 'more', 'custom'],
              ['Seats', '1', '1', 'multiple', 'custom'],
            ].map((r) => (
              <tr key={r[0]}>
                {r.map((c, i) => (
                  <td key={i}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Prices are placeholders until they are set.</p>
      </Modal>
    </div>
  );
}

/* ---------------- Account ---------------- */
interface Sess {
  id: string;
  created_at?: string;
  createdAt?: string;
  user_agent?: string | null;
  userAgent?: string | null;
  current?: boolean;
}
export function Account() {
  const { me, theme, toggleTheme, signOut, toast } = useApp();
  const sessions = useQuery(() => api<Sess[]>('/v1/auth/sessions'), []);
  return (
    <div className="page">
      <PageHead title="Account" />
      <div className="col">
        <Card title="Profile">
          <dl className="col small" style={{ margin: 0 }}>
            <div className="spread">
              <dt className="muted">Name</dt>
              <dd style={{ margin: 0 }}>{me?.displayName ?? '—'}</dd>
            </div>
            <div className="spread">
              <dt className="muted">Email</dt>
              <dd style={{ margin: 0 }}>{me?.email ?? '—'}</dd>
            </div>
            <div className="spread">
              <dt className="muted">User id</dt>
              <dd className="mono" style={{ margin: 0 }}>
                {me?.id}
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Sign-in methods">
          {me?.identities.map((i) => (
            <div key={i.provider + i.subject} className="spread small">
              <span className="chip">{i.provider}</span>
              <span className="mono muted trunc">{i.subject}</span>
            </div>
          ))}
          <p className="small muted mt">
            Linking a Sui wallet needs a browser wallet extension, which this build does not bundle.
          </p>
        </Card>
        <Card
          title="Sessions"
          actions={
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                try {
                  await api('/v1/auth/logout-all', { method: 'POST', body: {} });
                  toast('success', 'Signed out everywhere.');
                  await signOut();
                } catch (e) {
                  toast('error', (e as Error).message);
                }
              }}
            >
              Sign out everywhere
            </Button>
          }
        >
          <Async q={sessions} rows={2}>
            {(rows) => (
              <div className="col">
                {rows.map((s) => (
                  <div className="spread small" key={s.id}>
                    <span className="trunc">{s.user_agent ?? s.userAgent ?? 'Unknown device'}</span>
                    <span className="muted">
                      {s.current ? 'This device' : ago(s.created_at ?? s.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Async>
        </Card>
        <Card title="Appearance">
          <div className="row">
            <span>Theme: {theme}</span>
            <Button size="sm" onClick={toggleTheme}>
              Switch to {theme === 'dark' ? 'light' : 'dark'}
            </Button>
          </div>
        </Card>
        <Card title="Data">
          <p className="small muted">
            Export your data or delete your account by contacting the workspace owner. Self-service deletion
            is not part of this build.
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Notifications ---------------- */
export function Notifications() {
  const { wsId, projects } = useWs();
  const [sev, setSev] = useState('');
  const q = useQuery(
    async () => {
      const ps = projects.data ?? [];
      const all = await Promise.all(
        ps.map((p) =>
          api<Flag[]>(`/v1/projects/${p.id}/flags`).then((f) => f.map((x) => ({ ...x, project: p }))),
        ),
      );
      return all.flat().sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen));
    },
    [projects.data],
    { live: true },
  );
  return (
    <div className="page">
      <PageHead title="Notifications" desc="Recent alerts across all projects.">
        <select
          className="inp"
          style={{ width: 'auto' }}
          aria-label="Severity"
          value={sev}
          onChange={(e) => setSev(e.target.value)}
        >
          <option value="">All severities</option>
          <option>critical</option>
          <option>warning</option>
          <option>info</option>
        </select>
      </PageHead>
      <Async q={q} rows={3}>
        {(rows) => {
          const list = rows.filter((r) => !sev || r.severity === sev);
          return list.length === 0 ? (
            <Empty text="Nothing needs attention." />
          ) : (
            <div className="col">
              {list.map((f) => (
                <Link
                  key={f.id}
                  to={`/w/${wsId}/p/${f.project.id}/alerts`}
                  className="card row"
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  <span
                    className={cx('chip s')}
                    style={{
                      ['--c' as string]:
                        f.severity === 'critical'
                          ? 'var(--s-stale)'
                          : f.severity === 'warning'
                            ? 'var(--s-contested)'
                            : 'var(--s-proposed)',
                    }}
                  >
                    {f.severity}
                  </span>
                  <div className="grow">
                    <div>{f.detail}</div>
                    <div className="small muted">
                      {f.project.name} · {f.state} · {ago(f.last_seen)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          );
        }}
      </Async>
    </div>
  );
}
