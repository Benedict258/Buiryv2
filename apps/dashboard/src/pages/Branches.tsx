import { useState } from 'react';
import { GitMerge, Lock, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import type { Branch } from '../lib/types';
import {
  Async,
  Banner,
  BranchPill,
  Button,
  Card,
  Empty,
  Field,
  Modal,
  PageHead,
  StatusChip,
  Tabs,
} from '../components/ui';

interface Proposal {
  source: string;
  target: string;
  candidates: { memoryId: string; text: string; conflictWith: { memoryId: string; similarity: number }[] }[];
}

export function Branches() {
  const { projectId, setBranch, base } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const q = useQuery(
    () => api<{ branches: Branch[]; active: string }>(`/v1/projects/${projectId}/branches`),
    [projectId],
    { live: true },
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('main');
  const [merge, setMerge] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <div className="page">
      <PageHead title="Branches" desc="Isolated lines of memory. Merge confirmed knowledge back into main.">
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!can(role, 'writer')}
          onClick={() => setCreating(true)}
        >
          New branch
        </Button>
      </PageHead>
      <Card flush>
        <Async q={q} rows={3}>
          {(d) => (
            <div className="tbl-wrap">
              <table className="tbl cards">
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Parent</th>
                    <th>Memories</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.branches.map((b) => (
                    <tr key={b.slug} className="click" onClick={() => setDetail(b.slug)}>
                      <td>
                        <BranchPill name={b.slug} locked={b.protected} />
                      </td>
                      <td className="mono small">{b.parent ?? '—'}</td>
                      <td>{b.memoryCount}</td>
                      <td>
                        <span className="chip">{b.active ? 'Active' : 'Other'}</span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          <Button
                            size="sm"
                            onClick={() => {
                              setBranch(b.slug);
                              toast('info', `Switched to ${b.slug}.`);
                            }}
                          >
                            Switch
                          </Button>
                          {b.slug !== 'main' && (
                            <Button
                              size="sm"
                              icon={<GitMerge size={14} />}
                              disabled={!can(role, 'admin')}
                              title={
                                !can(role, 'admin')
                                  ? 'Merging into a protected branch needs an admin.'
                                  : undefined
                              }
                              onClick={() => setMerge(b.slug)}
                            >
                              Merge
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New branch"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  await api(`/v1/projects/${projectId}/branches`, {
                    method: 'POST',
                    body: { name: name.trim(), from },
                  });
                  toast('success', 'Branch created.');
                  setCreating(false);
                  setName('');
                  q.reload();
                  bump();
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
            <input
              id={id}
              className="inp mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Parent">
          {(id) => (
            <select id={id} className="inp" value={from} onChange={(e) => setFrom(e.target.value)}>
              {q.data?.branches.map((b) => (
                <option key={b.slug}>{b.slug}</option>
              ))}
            </select>
          )}
        </Field>
        <p className="small muted">Branches start empty and read through to their parent.</p>
      </Modal>
      {detail && <BranchDetail slug={detail} onClose={() => setDetail(null)} base={base} />}
      {merge && (
        <MergeWizard
          source={merge}
          onClose={() => {
            setMerge(null);
            q.reload();
            bump();
          }}
        />
      )}
    </div>
  );
}

function BranchDetail({ slug, onClose, base }: { slug: string; onClose: () => void; base: string }) {
  const { projectId } = useProject();
  const [tab, setTab] = useState<'compare' | 'memories'>('compare');
  const p = useQuery(
    () => api<Proposal>(`/v1/projects/${projectId}/branches/${slug}/merge-proposal`),
    [slug],
  );
  return (
    <Modal
      open
      onClose={onClose}
      large
      title={
        <span className="row">
          Branch <BranchPill name={slug} locked={slug === 'main'} />
        </span>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'compare', label: 'Compare with main' },
          { id: 'memories', label: 'Memories' },
        ]}
      />
      {tab === 'compare' ? (
        <Async q={p} rows={3}>
          {(d) =>
            d.candidates.length === 0 ? (
              <Empty text="Nothing to merge: this branch has no new memories." />
            ) : (
              <div className="col">
                <p className="small muted">
                  {d.candidates.length} new, {d.candidates.filter((c) => c.conflictWith.length).length} with
                  possible conflicts.
                </p>
                {d.candidates.map((c) => (
                  <div key={c.memoryId} className="card">
                    <div className="pre">{c.text}</div>
                    {c.conflictWith.length > 0 && (
                      <div className="small mt-s" style={{ color: 'var(--s-contested)' }}>
                        May conflict with {c.conflictWith.length} memor
                        {c.conflictWith.length === 1 ? 'y' : 'ies'} on {d.target}.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          }
        </Async>
      ) : (
        <a className="btn" href={`${base}/memory?branch=${slug}`}>
          Open the explorer on this branch
        </a>
      )}
    </Modal>
  );
}

type Res = 'include' | 'skip' | 'supersede' | 'distinct';
function MergeWizard({ source, onClose }: { source: string; onClose: () => void }) {
  const { projectId } = useProject();
  const { toast } = useApp();
  const [step, setStep] = useState(0);
  const [into, setInto] = useState('main');
  const p = useQuery(
    () => api<Proposal>(`/v1/projects/${projectId}/branches/${source}/merge-proposal?into=${into}`),
    [source, into],
  );
  const [picked, setPicked] = useState<Record<string, Res>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ merged?: unknown; [k: string]: unknown } | null>(null);
  const cands = p.data?.candidates ?? [];
  const chosen = cands.filter((c) => (picked[c.memoryId] ?? 'include') !== 'skip');
  const conflicts = chosen.filter((c) => c.conflictWith.length > 0);
  const set = (id: string, r: Res) => setPicked((x) => ({ ...x, [id]: r }));
  const go = async () => {
    setBusy(true);
    try {
      const items = chosen.map((c) => {
        const r = picked[c.memoryId] ?? 'include';
        return {
          memoryId: c.memoryId,
          ...(c.conflictWith.length
            ? {
                resolution:
                  r === 'supersede'
                    ? { kind: 'supersede', targetMemoryId: c.conflictWith[0]!.memoryId }
                    : { kind: 'distinct' },
              }
            : {}),
        };
      });
      setResult(
        await api(`/v1/projects/${projectId}/merge`, {
          method: 'POST',
          body: { source, target: into, items },
        }),
      );
      setStep(3);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unresolved = conflicts.some((c) => !['supersede', 'distinct'].includes(picked[c.memoryId] ?? ''));
  const supersedes = chosen.filter((c) => picked[c.memoryId] === 'supersede').length;
  return (
    <Modal
      open
      onClose={onClose}
      large
      title={`Merge ${source}`}
      footer={
        step < 3 ? (
          <>
            {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
            {step < 2 ? (
              <Button
                variant="primary"
                disabled={cands.length === 0 || (step === 1 && unresolved)}
                onClick={() => setStep(step + 1)}
              >
                Continue
              </Button>
            ) : (
              <Button variant="primary" loading={busy} onClick={go}>
                Merge
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )
      }
    >
      <div className="stepper" aria-label="Merge steps">
        {['Target', 'Select and resolve', 'Review', 'Done'].map((s, i) => (
          <div key={s} className={`st${i <= step ? ' done' : ''}`} title={s} />
        ))}
      </div>
      {into === 'main' && (
        <div className="small muted row">
          <Lock size={12} /> main is protected: merging needs an admin.
        </div>
      )}
      {step === 0 && (
        <Field label="Merge into">
          {(id) => (
            <select id={id} className="inp" value={into} onChange={(e) => setInto(e.target.value)}>
              <option>main</option>
            </select>
          )}
        </Field>
      )}
      {step <= 1 && (
        <Async q={p} rows={3}>
          {() =>
            cands.length === 0 ? (
              <Empty text="Nothing to merge." />
            ) : step === 0 ? (
              <p>
                {cands.length} memories on <span className="mono">{source}</span> could be merged into{' '}
                <span className="mono">{into}</span>.
              </p>
            ) : (
              <div className="col">
                {cands.map((c) => (
                  <div key={c.memoryId} className="card col">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={(picked[c.memoryId] ?? 'include') !== 'skip'}
                        onChange={(e) => set(c.memoryId, e.target.checked ? 'include' : 'skip')}
                      />
                      {c.text}
                    </label>
                    {c.conflictWith.length > 0 && (picked[c.memoryId] ?? 'include') !== 'skip' && (
                      <div className="row wrap small">
                        <span style={{ color: 'var(--s-contested)' }}>
                          Conflicts with {c.conflictWith.length}:
                        </span>
                        {(['supersede', 'distinct'] as const).map((k) => (
                          <label key={k} className="check">
                            <input
                              type="radio"
                              name={`r${c.memoryId}`}
                              checked={picked[c.memoryId] === k}
                              onChange={() => set(c.memoryId, k)}
                            />
                            {k === 'supersede' ? 'Supersede the existing memory' : 'Keep both as distinct'}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          }
        </Async>
      )}
      {step === 2 && (
        <Banner kind="info">
          This writes {chosen.length} new memories into {into} and marks {supersedes} as superseded.
        </Banner>
      )}
      {step === 3 && (
        <Banner kind="success">
          Merged. The merge record is in the activity log.
          <pre className="code mt-s small">{JSON.stringify(result, null, 2).slice(0, 600)}</pre>
        </Banner>
      )}
    </Modal>
  );
}
export { StatusChip };
