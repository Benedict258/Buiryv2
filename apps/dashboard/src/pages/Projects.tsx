import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp } from '../lib/app';
import { useWs } from '../lib/ctx';
import { ago, plural } from '../lib/format';
import type { ProjectCard } from '../lib/types';
import {
  Async,
  AgentBadge,
  Button,
  Card,
  CodeBlock,
  Empty,
  Field,
  IdBlock,
  Modal,
  PageHead,
  Segmented,
  Sparkline,
  Banner,
  cx,
} from '../components/ui';

export function Projects() {
  const { wsId, projects, role, plan } = useWs();
  const { toast } = useApp();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [health, setHealth] = useState<'all' | 'attention'>('all');
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [creating, setCreating] = useState(sp.get('new') === '1');
  const { ws } = useParams();
  const list = (projects.data ?? [])
    .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    .filter((p) => health === 'all' || p.openFlags > 0 || p.expiring > 0);
  return (
    <div className="page">
      <PageHead title="Projects" desc="Every project and its health at a glance.">
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!can(role, 'admin')}
          title={!can(role, 'admin') ? 'You need Admin access to create projects.' : undefined}
          onClick={() => setCreating(true)}
        >
          New project
        </Button>
      </PageHead>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <input
          className="inp"
          style={{ maxWidth: 280 }}
          placeholder="Search projects"
          aria-label="Search projects"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Segmented
          label="Health"
          value={health}
          onChange={setHealth}
          items={[
            { id: 'all', label: 'All' },
            { id: 'attention', label: 'Needs attention' },
          ]}
        />
        <span style={{ marginLeft: 'auto' }}>
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            items={[
              { id: 'cards', label: 'Cards' },
              { id: 'table', label: 'Table' },
            ]}
          />
        </span>
      </div>
      <Async q={projects} rows={3} empty={null}>
        {(all) =>
          all.length === 0 ? (
            <Empty text="No projects yet. Create one, then connect an agent and its first memory will appear here.">
              <CodeBlock value="npx buiry init" />
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first project
              </Button>
            </Empty>
          ) : list.length === 0 ? (
            <Empty text="No projects match these filters.">
              <Button
                onClick={() => {
                  setQ('');
                  setHealth('all');
                }}
              >
                Clear filters
              </Button>
            </Empty>
          ) : view === 'cards' ? (
            <div className="grid g3">
              {list.map((p) => (
                <ProjectCardView key={p.id} p={p} ws={ws!} />
              ))}
            </div>
          ) : (
            <Card flush>
              <div className="tbl-wrap">
                <table className="tbl cards">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Networks</th>
                      <th>Memories</th>
                      <th>Agents</th>
                      <th>Open flags</th>
                      <th>Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id} className="click" onClick={() => nav(`/w/${ws}/p/${p.id}/overview`)}>
                        <td>
                          <Link to={`/w/${ws}/p/${p.id}/overview`}>{p.name}</Link>
                        </td>
                        <td>{p.networks.join(', ')}</td>
                        <td>{p.memories}</td>
                        <td>{p.agents}</td>
                        <td>{p.openFlags}</td>
                        <td>{ago(p.lastActivity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        }
      </Async>
      <NewProject
        open={creating}
        onClose={() => {
          setCreating(false);
          setSp({}, { replace: true });
        }}
        wsId={wsId}
        plan={plan}
        onCreated={(p) => {
          toast('success', 'Project created.');
          projects.reload();
          nav(`/w/${wsId}/p/${p}/overview`);
        }}
      />
    </div>
  );
}

function ProjectCardView({ p, ws }: { p: ProjectCard; ws: string }) {
  const health = p.openFlags > 0 || p.expiring > 0 ? 'Needs attention' : 'Healthy';
  return (
    <Link
      to={`/w/${ws}/p/${p.id}/overview`}
      className="card col"
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      <div className="spread">
        <h3>{p.name}</h3>
        <span className="row small">
          <i className={cx('live-dot', p.openFlags > 0 || p.expiring > 0 ? 'retry' : 'on')} aria-hidden />
          {health}
        </span>
      </div>
      <div className="row wrap">
        {p.networks.map((n) => (
          <span key={n} className="chip">
            {n}
          </span>
        ))}
        {p.expiring > 0 && (
          <span className="chip s" style={{ ['--c' as string]: 'var(--s-expired)' }}>
            {p.expiring} expiring
          </span>
        )}
      </div>
      <div className="row small muted wrap">
        <span>{plural(p.memories, 'memory', 'memories')}</span>
        <span>·</span>
        <span>{plural(p.agents, 'agent')}</span>
        <span>·</span>
        <span>{plural(p.openFlags, 'open flag')}</span>
      </div>
      <div className="spread small muted">
        <span>Last activity {ago(p.lastActivity)}</span>
        <Sparkline
          values={[
            Math.max(0, p.memories - 4),
            Math.max(0, p.memories - 3),
            Math.max(0, p.memories - 3),
            Math.max(0, p.memories - 1),
            p.memories,
          ]}
        />
      </div>
      <div className="small faint">
        <IdBlock value={p.id} n={8} />
      </div>
    </Link>
  );
}

function NewProject({
  open,
  onClose,
  wsId,
  onCreated,
  plan,
}: {
  open: boolean;
  onClose: () => void;
  wsId: string;
  onCreated: (id: string) => void;
  plan: string;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [nets, setNets] = useState<string[]>(['sui:mainnet']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const p = await api<{ id: string }>(`/v1/workspaces/${wsId}/projects`, {
                  method: 'POST',
                  body: { name: name.trim(), ...(desc ? { description: desc } : {}), networks: nets },
                });
                onCreated(p.id);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create project
          </Button>
        </>
      }
    >
      {err && (
        <Banner
          kind="warning"
          action={
            err.toLowerCase().includes('limit') ? <Link to={`/w/${wsId}/billing`}>Upgrade</Link> : undefined
          }
        >
          {err} ({plan} plan)
        </Banner>
      )}
      <Field label="Name">
        {(id) => (
          <input id={id} className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        )}
      </Field>
      <Field label="Description (optional)">
        {(id) => (
          <input
            id={id}
            className="inp"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            maxLength={500}
          />
        )}
      </Field>
      <div className="row wrap">
        {['sui:mainnet', 'sui:testnet'].map((n) => (
          <label key={n} className="check chip">
            <input
              type="checkbox"
              checked={nets.includes(n)}
              onChange={(e) => setNets(e.target.checked ? [...nets, n] : nets.filter((x) => x !== n))}
            />
            {n}
          </label>
        ))}
      </div>
    </Modal>
  );
}

export { AgentBadge };
