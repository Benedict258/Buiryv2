import { useEffect, useMemo, useState } from 'react';
import { Plus, ShieldAlert, X } from 'lucide-react';
import { api, qs } from '../lib/api';
import { can, useApp } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { MEM_TYPES, type Evidence, type Memory, type MemType } from '../lib/types';
import { Banner, Button, EvidenceChip, Field, Modal, StatusChip } from '../components/ui';

/** Obvious-secret preview only. The service redacts and blocks authoritatively on save. */
const PREVIEW_RULES: { name: string; re: RegExp; block: boolean }[] = [
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, block: true },
  { name: 'recovery phrase', re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, block: true },
  { name: 'API key', re: /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9]{16,}\b/gi, block: false },
  { name: 'bearer token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, block: false },
  { name: 'email address', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, block: false },
];

type EvKind = 'tx' | 'object' | 'package' | 'file' | 'url' | 'test';
const EV_FIELDS: Record<EvKind, { key: string; label: string }[]> = {
  tx: [{ key: 'digest', label: 'Transaction digest' }],
  object: [{ key: 'id', label: 'Object id' }],
  package: [{ key: 'id', label: 'Package id' }],
  file: [
    { key: 'path', label: 'File path' },
    { key: 'commit', label: 'Commit (optional)' },
  ],
  url: [{ key: 'href', label: 'URL' }],
  test: [{ key: 'name', label: 'Test name' }],
};

export function MemoryEditor({
  open,
  onClose,
  supersede,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  supersede?: { memoryId: string; text: string; type: MemType; branch: string };
  onSaved?: (id: string) => void;
}) {
  const { projectId, branch: cur } = useProject();
  const { role } = useWs();
  const { toast, bump } = useApp();
  const [type, setType] = useState<MemType>(supersede?.type ?? 'decision');
  const [text, setText] = useState(supersede?.text ?? '');
  const [branch, setBranch] = useState(supersede?.branch ?? cur);
  const [relation, setRelation] = useState<'new' | 'supersedes' | 'distinct'>(
    supersede ? 'supersedes' : 'new',
  );
  const [target, setTarget] = useState(supersede?.memoryId ?? '');
  const [targetQ, setTargetQ] = useState('');
  const [targets, setTargets] = useState<Memory[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [evKind, setEvKind] = useState<EvKind>('tx');
  const [evVals, setEvVals] = useState<Record<string, string>>({});
  const [similar, setSimilar] = useState<Memory[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);

  const hits = useMemo(
    () =>
      PREVIEW_RULES.flatMap((r) =>
        [...text.matchAll(r.re)].map((m) => ({ ...r, at: m.index ?? 0, len: m[0].length })),
      ),
    [text],
  );
  const blocked = hits.some((h) => h.block);

  useEffect(() => {
    if (text.trim().length < 12) {
      setSimilar([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ items: Memory[] }>(`/v1/projects/${projectId}/memories${qs({ q: text.slice(0, 120), limit: 4 })}`)
        .then((r) => setSimilar(r.items.filter((m) => m.id !== supersede?.memoryId)))
        .catch(() => setSimilar([]));
    }, 350);
    return () => clearTimeout(t);
  }, [text, projectId, supersede?.memoryId]);
  useEffect(() => {
    if (relation !== 'supersedes' || supersede || targetQ.trim().length < 2) {
      setTargets([]);
      return;
    }
    const t = setTimeout(
      () =>
        api<{ items: Memory[] }>(`/v1/projects/${projectId}/memories${qs({ q: targetQ, limit: 5 })}`)
          .then((r) => setTargets(r.items))
          .catch(() => {}),
      250,
    );
    return () => clearTimeout(t);
  }, [targetQ, relation, projectId, supersede]);

  const addEvidence = () => {
    const fields = EV_FIELDS[evKind];
    const ev: Evidence = { kind: evKind };
    for (const f of fields) if (evVals[f.key]?.trim()) ev[f.key] = evVals[f.key]!.trim();
    if (evKind === 'test') ev.result = 'pass';
    if (fields.some((f) => !f.label.includes('optional') && !evVals[f.key]?.trim())) {
      setErr('Fill in the evidence fields first.');
      return;
    }
    setErr(null);
    setEvidence((e) => [...e, ev]);
    setEvVals({});
  };
  const fetchTx = async () => {
    const digest = evVals.digest?.trim();
    if (!digest) return;
    setFetchMsg('Checking the transaction…');
    try {
      const r = await api<{ results: { result: string; detail: string }[]; extracted?: Evidence[] }>(
        `/v1/projects/${projectId}/verifications`,
        { method: 'POST', body: { evidence: { kind: 'tx', digest } } },
      );
      const x = r.extracted ?? [];
      setEvidence((e) => [
        ...e,
        { kind: 'tx', digest },
        ...x.filter((n) => !e.some((o) => JSON.stringify(o) === JSON.stringify(n))),
      ]);
      setEvVals({});
      setFetchMsg(
        `${r.results[0]?.result ?? 'unknown'}: ${r.results[0]?.detail ?? ''}. Added ${x.length} extracted identifier${x.length === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      setFetchMsg((e as Error).message);
    }
  };

  const save = async (st: 'proposed' | 'confirmed') => {
    setSaving(true);
    setErr(null);
    try {
      const rel = relation === 'new' ? undefined : { kind: relation, memoryId: target };
      if (relation !== 'new' && !target) throw new Error('Choose the memory this relates to.');
      const r = await api<{
        memoryId: string;
        duplicate: boolean;
        redaction: { applied: boolean; kinds: string[] };
      }>(`/v1/projects/${projectId}/memories`, {
        method: 'POST',
        body: {
          text,
          type,
          branch,
          ...(evidence.length ? { evidence } : {}),
          ...(rel ? { relation: rel } : {}),
          status: st,
        },
      });
      toast(
        'success',
        r.duplicate
          ? 'That memory already exists.'
          : r.redaction.applied
            ? `Saved. Masked: ${r.redaction.kinds.join(', ')}.`
            : 'Memory saved.',
      );
      bump();
      onSaved?.(r.memoryId);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      large
      title={supersede ? 'Supersede memory' : 'New memory'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {can(role, 'admin') && (
            <Button loading={saving} disabled={blocked || !text.trim()} onClick={() => save('confirmed')}>
              Save as confirmed
            </Button>
          )}
          <Button
            variant="primary"
            loading={saving}
            disabled={blocked || !text.trim()}
            onClick={() => save('proposed')}
          >
            Save as proposed
          </Button>
        </>
      }
    >
      {err && <Banner kind="error">{err}</Banner>}
      <div className="grid g2">
        <Field label="Type">
          {(id) => (
            <select id={id} className="inp" value={type} onChange={(e) => setType(e.target.value as MemType)}>
              {MEM_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Branch">
          {(id) => (
            <input id={id} className="inp mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          )}
        </Field>
      </div>
      <Field
        label="Text"
        help={`${text.length} characters. Prefer a summary and a reference to long content.`}
      >
        {(id) => (
          <textarea id={id} className="inp" value={text} onChange={(e) => setText(e.target.value)} rows={4} />
        )}
      </Field>
      {hits.length > 0 && (
        <Banner kind={blocked ? 'error' : 'warning'}>
          <strong>{blocked ? 'This text cannot be saved.' : 'Some content will be masked.'}</strong>{' '}
          {hits
            .map((h) => h.name)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(', ')}{' '}
          detected.{' '}
          {blocked ? 'Remove the secret and describe it instead.' : 'Buiry masks these before storing.'}
        </Banner>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="lab" style={{ fontWeight: 500, fontSize: 13 }}>
          Relation
        </legend>
        <div className="row wrap mt-s">
          {(['new', 'supersedes', 'distinct'] as const).map((r) => (
            <label className="check" key={r}>
              <input
                type="radio"
                name="rel"
                checked={relation === r}
                onChange={() => setRelation(r)}
                disabled={!!supersede && r !== 'supersedes'}
              />
              {r === 'new'
                ? 'New'
                : r === 'supersedes'
                  ? 'Supersedes another memory'
                  : 'Distinct from another memory'}
            </label>
          ))}
        </div>
        {relation !== 'new' && !supersede && (
          <div className="col mt-s">
            <input
              className="inp"
              placeholder="Search for the memory"
              aria-label="Search for the related memory"
              value={targetQ}
              onChange={(e) => setTargetQ(e.target.value)}
            />
            {targets.map((t) => (
              <button
                key={t.id}
                className="btn ghost"
                style={{
                  justifyContent: 'flex-start',
                  background: target === t.id ? 'var(--brand-subtle)' : undefined,
                }}
                onClick={() => setTarget(t.id)}
              >
                <StatusChip status={t.status} />
                <span className="trunc">{t.text}</span>
              </button>
            ))}
          </div>
        )}
      </fieldset>
      <div className="card">
        <div className="label">Evidence</div>
        <div className="row wrap mt-s">
          {evidence.map((e, i) => (
            <span className="row" key={i} style={{ gap: 2 }}>
              <EvidenceChip e={e} />
              <button
                className="btn ghost icon sm"
                aria-label="Remove evidence"
                onClick={() => setEvidence((x) => x.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {evidence.length === 0 && <span className="faint small">None attached.</span>}
        </div>
        <div className="row wrap mt-s" style={{ alignItems: 'flex-end' }}>
          <Field label="Kind">
            {(id) => (
              <select
                id={id}
                className="inp"
                value={evKind}
                onChange={(e) => {
                  setEvKind(e.target.value as EvKind);
                  setEvVals({});
                }}
              >
                {Object.keys(EV_FIELDS).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            )}
          </Field>
          {EV_FIELDS[evKind].map((f) => (
            <Field key={f.key} label={f.label}>
              {(id) => (
                <input
                  id={id}
                  className="inp mono"
                  value={evVals[f.key] ?? ''}
                  onChange={(e) => setEvVals({ ...evVals, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
          <Button icon={<Plus size={14} />} onClick={addEvidence}>
            Add
          </Button>
          {evKind === 'tx' && (
            <Button onClick={fetchTx} disabled={!evVals.digest?.trim()}>
              Fetch and verify
            </Button>
          )}
        </div>
        {fetchMsg && (
          <div className="small muted mt-s" role="status">
            {fetchMsg}
          </div>
        )}
      </div>
      {similar.length > 0 && (
        <div className="card">
          <div className="label">
            <ShieldAlert size={12} /> Possible conflicts
          </div>
          {similar.map((m) => (
            <div key={m.id} className="small row mt-s">
              <StatusChip status={m.status} />
              <span className="trunc grow">{m.text}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
