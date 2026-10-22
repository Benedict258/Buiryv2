import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { ago } from '../lib/format';
import { MEM_TYPES } from '../lib/types';
import { Async, Banner, Button, Card, Empty, Field, PageHead } from '../components/ui';

interface Preview {
  valid: boolean;
  errors: string[];
  counts: { total: number; byType: Record<string, number> };
  items: {
    id: string;
    type: string;
    text: string;
    redaction: string[];
    blocked: boolean;
    injection: string[];
    duplicate: boolean;
  }[];
}
interface PackRow {
  id: string;
  direction: string;
  actor: string;
  counts: { total?: number };
  created_at: string;
}

export function Packs() {
  const { projectId, branch } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const hist = useQuery(() => api<PackRow[]>(`/v1/projects/${projectId}/packs`), [projectId]);
  const [types, setTypes] = useState<string[]>([]);
  const [withEv, setWithEv] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [pack, setPack] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('main');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const writer = can(role, 'writer');

  const doExport = async () => {
    setExporting(true);
    try {
      const p = await api<unknown>(`/v1/projects/${projectId}/packs/export`, {
        method: 'POST',
        body: { branch, ...(types.length ? { types } : {}), includeEvidence: withEv },
      });
      const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), {
        href: url,
        download: `buiry-pack-${branch}.json`,
      }).click();
      URL.revokeObjectURL(url);
      toast('success', 'Pack exported.');
      hist.reload();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const load = async (f: File) => {
    setFileName(f.name);
    setDone(null);
    try {
      const parsed = JSON.parse(await f.text());
      setPack(parsed);
      setPreview(
        await api<Preview>(`/v1/projects/${projectId}/packs/preview`, {
          method: 'POST',
          body: { pack: parsed },
        }),
      );
      setSkip(new Set());
    } catch (e) {
      setPack(null);
      setPreview(null);
      toast('error', e instanceof SyntaxError ? 'That file is not valid JSON.' : (e as Error).message);
    }
  };
  const doImport = async () => {
    if (!preview || !pack) return;
    setBusy(true);
    try {
      const only = preview.items.filter((i) => !skip.has(i.id) && !i.blocked).map((i) => i.id);
      setDone(
        await api(`/v1/projects/${projectId}/packs/import`, {
          method: 'POST',
          body: { pack, branch: target, only },
        }),
      );
      toast('success', 'Pack imported as proposed memories.');
      bump();
      hist.reload();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHead title="Memory packs" desc="Move memory between projects and tools as a portable file." />
      <div className="grid g2">
        <Card title="Export a pack">
          <div className="col">
            <div className="small muted">
              Branch: <span className="mono">{branch}</span>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="lab" style={{ fontSize: 13, fontWeight: 500 }}>
                Types (none selected means all)
              </legend>
              <div className="row wrap mt-s">
                {MEM_TYPES.map((t) => (
                  <label key={t} className="check chip">
                    <input
                      type="checkbox"
                      checked={types.includes(t)}
                      onChange={(e) =>
                        setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))
                      }
                    />
                    {t.replace('_', ' ')}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={withEv} onChange={(e) => setWithEv(e.target.checked)} />
              Include evidence
            </label>
            <Button variant="primary" icon={<Download size={14} />} loading={exporting} onClick={doExport}>
              Export
            </Button>
          </div>
        </Card>
        <Card title="Import a pack">
          <div className="col">
            <div
              className="empty"
              style={{ border: '1px dashed var(--border-default)', borderRadius: 8, padding: 24 }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) void load(f);
              }}
            >
              <Upload size={24} />
              <div>Drop a pack file here</div>
              <Button disabled={!writer} onClick={() => input.current?.click()}>
                Choose file
              </Button>
              <input
                ref={input}
                type="file"
                accept="application/json,.json"
                hidden
                aria-label="Pack file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void load(f);
                }}
              />
            </div>
            {!writer && <div className="small muted">You need Writer access to import.</div>}
          </div>
        </Card>
      </div>

      {preview && (
        <Card title={`Import preview: ${fileName}`} className="mt">
          {!preview.valid && <Banner kind="error">{preview.errors.join('; ')}</Banner>}
          {preview.valid && (
            <>
              <div className="row wrap small muted">
                {preview.counts.total} memories ·{' '}
                {Object.entries(preview.counts.byType)
                  .map(([t, n]) => `${n} ${t}`)
                  .join(', ')}
              </div>
              <div className="mt-s small">
                Redaction and injection scan:{' '}
                {preview.items.filter((i) => i.redaction.length || i.injection.length || i.blocked).length}{' '}
                item(s) flagged.
              </div>
              <div className="col mt">
                {preview.items.map((i) => (
                  <label key={i.id} className="card row" style={{ alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={!skip.has(i.id) && !i.blocked}
                      disabled={i.blocked || i.duplicate}
                      onChange={(e) =>
                        setSkip((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.delete(i.id);
                          else n.add(i.id);
                          return n;
                        })
                      }
                    />
                    <div className="grow">
                      <div className="small pre">{i.text}</div>
                      <div className="row wrap mt-s">
                        {i.blocked && (
                          <span className="chip s" style={{ ['--c' as string]: 'var(--s-stale)' }}>
                            blocked: contains a secret
                          </span>
                        )}
                        {i.redaction.map((r) => (
                          <span
                            key={r}
                            className="chip s"
                            style={{ ['--c' as string]: 'var(--s-contested)' }}
                          >
                            masked {r}
                          </span>
                        ))}
                        {i.injection.map((r) => (
                          <span
                            key={r}
                            className="chip s"
                            style={{ ['--c' as string]: 'var(--s-contested)' }}
                          >
                            possible instruction: {r}
                          </span>
                        ))}
                        {i.duplicate && <span className="chip">already imported</span>}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="row mt" style={{ alignItems: 'flex-end' }}>
                <Field label="Target branch">
                  {(id) => (
                    <input
                      id={id}
                      className="inp mono"
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    />
                  )}
                </Field>
                <Button variant="primary" loading={busy} onClick={doImport}>
                  Import selected
                </Button>
              </div>
              <p className="small muted mt-s">Imported memories arrive as proposed.</p>
            </>
          )}
          {done != null && (
            <Banner kind="success">
              Import finished: <span className="mono">{JSON.stringify(done)}</span>
            </Banner>
          )}
        </Card>
      )}

      <Card title="History" flush className="mt">
        <Async q={hist} rows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty text="No exports or imports yet." />
            ) : (
              <table className="tbl cards">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Direction</th>
                    <th>By</th>
                    <th>Memories</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="small muted">{ago(r.created_at)}</td>
                      <td>
                        <span className="chip">{r.direction}</span>
                      </td>
                      <td className="mono small">{r.actor}</td>
                      <td>{r.counts?.total ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Async>
      </Card>
    </div>
  );
}
