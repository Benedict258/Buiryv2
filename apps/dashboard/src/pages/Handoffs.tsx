import { useState } from 'react';
import { Copy } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useApp, useQuery } from '../lib/app';
import { useProject } from '../lib/ctx';
import { ago } from '../lib/format';
import type { Handoff } from '../lib/types';
import { AgentBadge, Async, BranchPill, Button, Card, Empty, PageHead } from '../components/ui';

export function Handoffs() {
  const { projectId, openMemory } = useProject();
  const { toast } = useApp();
  const [agent, setAgent] = useState('');
  const q = useQuery(() => api<Handoff[]>(`/v1/projects/${projectId}/handoffs${qs({})}`), [projectId], {
    live: true,
  });
  const agents = [...new Set((q.data ?? []).map((h) => h.agent_slug))];
  return (
    <div className="page">
      <PageHead title="Handoffs" desc="What each session finished, what is blocked and what comes next.">
        <select
          className="inp"
          style={{ width: 'auto' }}
          aria-label="Agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </PageHead>
      <Async q={q} rows={3}>
        {(all) => {
          const list = all.filter((h) => !agent || h.agent_slug === agent);
          return list.length === 0 ? (
            <Empty text="No handoffs yet. Agents write one at the end of a session so the next session can pick up." />
          ) : (
            <div className="col">
              {list.map((h) => (
                <Card
                  key={h.id}
                  title={
                    <span className="row">
                      <AgentBadge name={h.agent_slug} />
                      <BranchPill name={h.branch_slug} />
                      <span className="faint small">{ago(h.created_at)}</span>
                    </span>
                  }
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Copy size={12} />}
                      disabled={h.next.length === 0}
                      onClick={() => {
                        void navigator.clipboard?.writeText(h.next.map((n) => `- ${n}`).join('\n'));
                        toast('info', 'Next steps copied.');
                      }}
                    >
                      Copy next steps
                    </Button>
                  }
                >
                  <div className="grid g3">
                    {(
                      [
                        ['Done', h.done],
                        ['Blocked', h.blocked],
                        ['Next', h.next],
                      ] as const
                    ).map(([t, items]) => (
                      <div key={t}>
                        <div className="label">{t}</div>
                        {items.length === 0 ? (
                          <div className="faint small mt-s">None</div>
                        ) : (
                          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                            {items.map((i, k) => (
                              <li key={k} className="small">
                                {i}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                  {h.notes && <p className="small muted mt">{h.notes}</p>}
                  {h.relied_on.length > 0 && (
                    <div className="row wrap mt">
                      <span className="small muted">Relied on</span>
                      {h.relied_on.map((m) => (
                        <button
                          key={m}
                          className="chip mono"
                          style={{ cursor: 'pointer', background: 'none' }}
                          onClick={() => openMemory(m)}
                        >
                          {m.slice(0, 14)}…
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          );
        }}
      </Async>
    </div>
  );
}
