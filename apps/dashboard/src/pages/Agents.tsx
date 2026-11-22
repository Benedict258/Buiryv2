import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, RotateCw, ShieldOff } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago, dateOnly } from '../lib/format';
import type { Agent, Memory } from '../lib/types';
import {
  Async,
  AgentBadge,
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
  ConfidenceMeter,
  StatusChip,
} from '../components/ui';

const TOOLS = ['claude-code', 'opencode', 'cursor', 'codex', 'other'];
/**
 * Agent permissions. The stored value `confirm` lets an agent contest a memory for a person to review; agents never
 * confirm, and cannot contest a memory a person confirmed (M8, Phase 8 B2), so it is shown as "contest".
 */
export const AGENT_PERMS = [
  ['read', 'Read: check, recall and read memories'],
  ['write', 'Write: record memories, reports and handoffs'],
  [
    'confirm',
    'Contest: flag a memory as contested for a person to review. Agents never confirm; only a person confirms',
  ],
] as const;
const permLabel = (p: string) => (p === 'confirm' ? 'contest' : p);

/** An agent's permissions as chips, with the stored `confirm` shown as "contest". */
export function PermChips({ perms }: { perms: string[] }) {
  return (
    <div className="row wrap">
      {perms.map((p) => (
        <span key={p} className="chip">
          {permLabel(p)}
        </span>
      ))}
    </div>
  );
}

export function Agents() {
  const { projectId, openMemory } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const [sp, setSp] = useSearchParams();
  const q = useQuery(() => api<Agent[]>(`/v1/projects/${projectId}/agents`), [projectId], { live: true });
  const [connect, setConnect] = useState(sp.get('connect') === '1');
  const [detail, setDetail] = useState<Agent | null>(null);
  const [revoke, setRevoke] = useState<Agent | null>(null);
  const [issued, setIssued] = useState<{ title: string; token: string; tool: string } | null>(null);
  const admin = can(role, 'admin');
  const rotate = async (a: Agent) => {
    try {
      const r = await api<{ token: string }>(`/v1/agents/${a.id}/tokens`, { method: 'POST', body: {} });
      setIssued({ title: `New token for ${a.slug}`, token: r.token, tool: a.tool });
      q.reload();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  return (
    <div className="page wide">
      <PageHead title="Agents" desc="Control which agents can read and write, and see how they behave.">
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!admin}
          title={!admin ? 'You need Admin access to connect agents.' : undefined}
          onClick={() => setConnect(true)}
        >
          Connect an agent
        </Button>
      </PageHead>
      {(q.data ?? []).some((a) => a.tokenExpiresSoon) && (
        <Banner kind="warning">
          {(q.data ?? [])
            .filter((a) => a.tokenExpiresSoon)
            .map((a) => a.name)
            .join(', ')}{' '}
          {(q.data ?? []).filter((a) => a.tokenExpiresSoon).length === 1 ? 'has a token' : 'have tokens'}{' '}
          expiring within 14 days. Rotate the token (the old one stops working at once) and update the tool
          with `buiry connect`.
        </Banner>
      )}
      <Card flush>
        <Async q={q} rows={3}>
          {(list) =>
            list.length === 0 ? (
              <Empty text="No agents yet. Connect your first agent to start building memory.">
                <Button variant="primary" onClick={() => setConnect(true)}>
                  Connect an agent
                </Button>
              </Empty>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Status</th>
                      <th>Permissions</th>
                      <th>Branch scope</th>
                      <th>Writes 7d</th>
                      <th>Recalls 7d</th>
                      <th>Reports</th>
                      <th>Last seen</th>
                      <th>Token used</th>
                      <th>Token expires</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((a) => {
                      const reports = a.helped7d + a.wrong7d;
                      return (
                        <tr key={a.id} className="click" onClick={() => setDetail(a)}>
                          <td>
                            <AgentBadge name={a.slug} tool={a.tool} status={a.status} />
                            <div className="faint small">
                              {a.tool}
                              {a.clientVersion ? ` ${a.clientVersion}` : ''}
                            </div>
                          </td>
                          <td>
                            <span
                              className={`chip${a.status === 'revoked' ? '' : ' s'}`}
                              style={
                                a.status === 'active'
                                  ? { ['--c' as string]: 'var(--s-confirmed)' }
                                  : undefined
                              }
                            >
                              {a.status}
                            </span>
                          </td>
                          <td>
                            <PermChips perms={a.permissions} />
                          </td>
                          <td className="mono small">{a.branchScope ?? 'all'}</td>
                          <td>{a.writes7d}</td>
                          <td>{a.recalls7d}</td>
                          <td>
                            {reports === 0 ? (
                              <span className="faint small">none</span>
                            ) : (
                              <span
                                title={`${a.helped7d} helpful, ${a.wrong7d} wrong`}
                                className="stack-bar"
                                style={{ width: 60, display: 'inline-flex' }}
                              >
                                <i
                                  style={{
                                    ['--c' as string]: 'var(--s-confirmed)',
                                    width: `${(a.helped7d / reports) * 100}%`,
                                  }}
                                />
                                <i
                                  style={{
                                    ['--c' as string]: 'var(--s-stale)',
                                    width: `${(a.wrong7d / reports) * 100}%`,
                                  }}
                                />
                              </span>
                            )}
                          </td>
                          <td className="small muted">{ago(a.lastSeenAt)}</td>
                          <td className="small muted">{ago(a.tokenLastUsed)}</td>
                          <td className={`small ${a.tokenExpiresSoon ? '' : 'muted'}`}>
                            {a.tokenExpiresAt ? dateOnly(a.tokenExpiresAt) : 'no expiry'}
                            {a.tokenExpiresSoon && <span className="chip">rotate soon</span>}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {a.status !== 'revoked' && (
                              <span className="row">
                                <Button
                                  size="sm"
                                  icon={<RotateCw size={12} />}
                                  disabled={!admin}
                                  onClick={() => rotate(a)}
                                >
                                  Rotate
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  icon={<ShieldOff size={12} />}
                                  disabled={!admin}
                                  onClick={() => setRevoke(a)}
                                >
                                  Revoke
                                </Button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Card>
      {connect && (
        <ConnectModal
          onClose={() => {
            setConnect(false);
            setSp({}, { replace: true });
          }}
          onIssued={(i) => {
            setConnect(false);
            setIssued(i);
            q.reload();
            bump();
          }}
        />
      )}
      <Modal
        open={!!issued}
        onClose={() => setIssued(null)}
        title={issued?.title ?? ''}
        footer={
          <Button variant="primary" onClick={() => setIssued(null)}>
            Done
          </Button>
        }
      >
        {issued && (
          <>
            <TokenReveal token={issued.token} />
            <div className="label">Ready-to-paste configuration</div>
            <CodeBlock
              value={JSON.stringify(
                {
                  mcpServers: {
                    buiry: {
                      type: 'http',
                      url: `${window.location.origin}/mcp`,
                      headers: { Authorization: `Bearer ${issued.token}` },
                    },
                  },
                },
                null,
                2,
              )}
            />
            <p className="small muted">
              Or run{' '}
              <span className="mono">
                npx buiry connect {issued.tool === 'other' ? '--print' : issued.tool}
              </span>{' '}
              in your repository.
            </p>
          </>
        )}
      </Modal>
      <ConfirmModal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        danger
        title={`Revoke ${revoke?.slug}`}
        confirmLabel="Revoke agent"
        body="This agent loses access immediately. Memories it wrote stay in the project."
        onConfirm={async () => {
          await api(`/v1/agents/${revoke!.id}`, { method: 'DELETE' });
          toast('success', 'Agent revoked.');
          q.reload();
        }}
      />
      <AgentDrawer
        agent={detail}
        onClose={() => setDetail(null)}
        onOpenMemory={(id) => {
          setDetail(null);
          openMemory(id);
        }}
      />
    </div>
  );
}

function ConnectModal({
  onClose,
  onIssued,
}: {
  onClose: () => void;
  onIssued: (i: { title: string; token: string; tool: string }) => void;
}) {
  const { projectId } = useProject();
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [tool, setTool] = useState('claude-code');
  const [perms, setPerms] = useState<string[]>(['read', 'write']);
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect an agent"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ token: string }>(`/v1/projects/${projectId}/agents`, {
                  method: 'POST',
                  body: {
                    name: name.trim(),
                    tool,
                    permissions: perms,
                    ...(scope ? { branchScope: scope } : {}),
                  },
                });
                onIssued({ title: `Token for ${name}`, token: r.token, tool });
              } catch (e) {
                toast('error', (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create token
          </Button>
        </>
      }
    >
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className="inp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="claude-code"
          />
        )}
      </Field>
      <Field label="Tool">
        {(id) => (
          <select id={id} className="inp" value={tool} onChange={(e) => setTool(e.target.value)}>
            {TOOLS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        )}
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="lab" style={{ fontSize: 13, fontWeight: 500 }}>
          Permissions
        </legend>
        <div className="col mt-s">
          {AGENT_PERMS.map(([p, d]) => (
            <label className="check" key={p}>
              <input
                type="checkbox"
                checked={perms.includes(p)}
                disabled={p === 'read'}
                onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))}
              />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Branch scope (optional)" help="Leave empty for all branches.">
        {(id) => (
          <input id={id} className="inp mono" value={scope} onChange={(e) => setScope(e.target.value)} />
        )}
      </Field>
    </Modal>
  );
}

function AgentDrawer({
  agent,
  onClose,
  onOpenMemory,
}: {
  agent: Agent | null;
  onClose: () => void;
  onOpenMemory: (id: string) => void;
}) {
  const { projectId } = useProject();
  const [tab, setTab] = useState<'overview' | 'memories' | 'token'>('overview');
  const mems = useQuery(
    () =>
      agent
        ? api<{ items: Memory[] }>(`/v1/projects/${projectId}/memories?agent=${agent.slug}&limit=20`)
        : Promise.resolve({ items: [] }),
    [agent?.slug, tab],
  );
  if (!agent) return null;
  const types = new Map<string, number>();
  for (const m of mems.data?.items ?? []) types.set(m.type, (types.get(m.type) ?? 0) + 1);
  return (
    <Drawer
      open
      onClose={onClose}
      header={
        <div className="col" style={{ gap: 4 }}>
          <AgentBadge name={agent.slug} tool={agent.tool} status={agent.status} />
          <span className="small muted">
            {agent.status} · created {ago(agent.createdAt)}
          </span>
        </div>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'memories', label: 'Memories written' },
          { id: 'token', label: 'Token' },
        ]}
      />
      {tab === 'overview' && (
        <div className="col">
          <div className="grid g2">
            <div className="card">
              <div className="label">Writes (7d)</div>
              <div className="v" style={{ fontSize: 24 }}>
                {agent.writes7d}
              </div>
            </div>
            <div className="card">
              <div className="label">Recalls (7d)</div>
              <div style={{ fontSize: 24 }}>{agent.recalls7d}</div>
            </div>
          </div>
          <div className="small muted">
            Helpful reports {agent.helped7d} · wrong reports {agent.wrong7d}
          </div>
          <div className="label">Top types written</div>
          {[...types.entries()].map(([t, n]) => (
            <div key={t} className="spread small">
              <span>{t}</span>
              <span className="mono">{n}</span>
            </div>
          ))}
          {types.size === 0 && <span className="faint small">No memories yet.</span>}
        </div>
      )}
      {tab === 'memories' && (
        <Async q={mems} rows={3}>
          {(r) =>
            r.items.length === 0 ? (
              <Empty text="This agent has not written memories yet." />
            ) : (
              <div className="col">
                {r.items.map((m) => (
                  <button
                    key={m.id}
                    className="card btn ghost"
                    style={{ textAlign: 'left', whiteSpace: 'normal', display: 'block' }}
                    onClick={() => onOpenMemory(m.id)}
                  >
                    <div className="row wrap">
                      <StatusChip status={m.status} />
                      <ConfidenceMeter value={m.effectiveConfidence} />
                    </div>
                    <div className="clamp2 mt-s">{m.text}</div>
                  </button>
                ))}
              </div>
            )
          }
        </Async>
      )}
      {tab === 'token' && (
        <div className="col">
          <div className="small muted">
            Last used {ago(agent.tokenLastUsed)}.{' '}
            {agent.tokenExpiresAt
              ? `Expires ${dateOnly(agent.tokenExpiresAt)}.`
              : 'No expiry (issued before token lifetimes were set, or lifetimes are off).'}{' '}
            Token values are shown once at creation; rotate to get a new one. Rotation revokes the old token
            at once.
          </div>
          <div className="code">bry_at_••••••••••••••••</div>
          <Banner kind="info">
            Permissions: {agent.permissions.map(permLabel).join(', ')}. Branch scope:{' '}
            {agent.branchScope ?? 'all branches'}.
          </Banner>
        </div>
      )}
    </Drawer>
  );
}
