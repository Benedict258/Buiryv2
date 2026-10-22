import { useState } from 'react';
import { api, qs } from '../lib/api';
import { useQuery } from '../lib/app';
import { useProject } from '../lib/ctx';
import { Async, Banner, Button, Card, CopyButton, Empty, Field, PageHead } from '../components/ui';

interface BriefOut {
  briefing: string;
  flags: unknown[];
  newEvents: number;
  generatedAt: string;
  onboarding: boolean;
  tokensUsed: number;
}

export function Briefing() {
  const { projectId, branch, openMemory } = useProject();
  const [task, setTask] = useState('');
  const [budget, setBudget] = useState(1500);
  const [onboarding, setOnboarding] = useState(false);
  const [applied, setApplied] = useState({ task: '', budget: 1500, onboarding: false });
  const q = useQuery(
    () =>
      api<BriefOut>(
        `/v1/projects/${projectId}/briefing${qs({ task: applied.task, budget: applied.budget, onboarding: applied.onboarding, branch })}`,
      ),
    [projectId, branch, JSON.stringify(applied)],
    { live: true },
  );
  return (
    <div className="page wide">
      <PageHead
        title="Briefing preview"
        desc="Exactly what an agent would receive at the start of a session."
      />
      <div className="split">
        <Card title="Controls" className="filter-rail">
          <div className="col">
            <Field label="Task description">
              {(id) => (
                <textarea
                  id={id}
                  className="inp"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="Migrate the users table"
                />
              )}
            </Field>
            <Field label={`Token budget: ${budget}`}>
              {(id) => (
                <input
                  id={id}
                  type="range"
                  min={300}
                  max={4000}
                  step={100}
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              )}
            </Field>
            <label className="check">
              <input type="checkbox" checked={onboarding} onChange={(e) => setOnboarding(e.target.checked)} />
              Onboarding briefing
            </label>
            <div className="small muted">
              Branch: <span className="mono">{branch}</span>
            </div>
            <Button variant="primary" onClick={() => setApplied({ task, budget, onboarding })}>
              Build briefing
            </Button>
          </div>
        </Card>
        <div className="grow" style={{ minWidth: 0 }}>
          <Async q={q} rows={8}>
            {(b) => {
              const sections = parse(b.briefing);
              return sections.items === 0 ? (
                <Empty text="The briefing builds up as memories arrive. This project has none yet." />
              ) : (
                <Card
                  title="Rendered briefing"
                  actions={
                    <>
                      <span className="small muted">
                        {b.tokensUsed} of {applied.budget} tokens
                      </span>
                      <CopyButton value={b.briefing} label="Copy as markdown" />
                    </>
                  }
                >
                  <div className="untrusted small">{sections.preamble}</div>
                  {sections.groups.map((g) => (
                    <section key={g.title} className="mt">
                      <h4>{g.title}</h4>
                      <ul className="col" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                        {g.lines.map((l, i) => (
                          <li key={i} className="small" style={{ lineHeight: '20px' }}>
                            {l.meta && (
                              <span className="chip mono" style={{ marginRight: 6 }}>
                                {l.meta}
                              </span>
                            )}
                            {l.id ? (
                              <button
                                className="btn ghost sm mono"
                                style={{ padding: '0 4px' }}
                                onClick={() => openMemory(l.id!)}
                              >
                                {l.id.slice(0, 12)}…
                              </button>
                            ) : null}
                            <span> {l.text}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  {b.tokensUsed > applied.budget && (
                    <Banner kind="warning">Over budget: lower-priority items were trimmed.</Banner>
                  )}
                </Card>
              );
            }}
          </Async>
        </div>
      </div>
    </div>
  );
}

function parse(md: string) {
  const lines = md.split('\n');
  const preamble = lines.find((l) => l.startsWith('>'))?.replace(/^>\s*/, '') ?? '';
  const groups: { title: string; lines: { meta?: string; id?: string; text: string }[] }[] = [];
  let items = 0;
  for (const l of lines) {
    if (l.startsWith('## ')) groups.push({ title: l.slice(3), lines: [] });
    else if (l.startsWith('- ') && groups.length) {
      const m = /^- (?:\[([^\]]*)\] )?(?:(mem_\w+): )?(.*)$/.exec(l);
      const flag = /^- ([A-Z ]+) (mem_\w+): (.*)$/.exec(l);
      const g = groups[groups.length - 1]!;
      if (flag) g.lines.push({ meta: flag[1]!, id: flag[2]!, text: flag[3]! });
      else if (m)
        g.lines.push({ ...(m[1] ? { meta: m[1] } : {}), ...(m[2] ? { id: m[2] } : {}), text: m[3]! });
      items++;
    }
  }
  return { preamble, groups, items };
}
