/* eslint-disable @typescript-eslint/no-explicit-any -- project settings are an open JSON object */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { MEM_TYPES } from '../lib/types';
import { Async, Banner, Button, Card, CodeBlock, ConfirmModal, Field, PageHead } from '../components/ui';

interface Proj {
  id: string;
  name: string;
  description?: string | null;
  networks: string[];
  settings: Record<string, any>;
  walrus_account_id: string | null;
}
type Section =
  'general' | 'memory' | 'redaction' | 'verification' | 'storage' | 'branches' | 'buirymd' | 'showcase';
const SECTIONS: [Section, string][] = [
  ['general', 'General'],
  ['memory', 'Memory rules'],
  ['redaction', 'Redaction'],
  ['verification', 'Verification'],
  ['storage', 'Storage'],
  ['branches', 'Branches'],
  ['buirymd', 'BUIRY.md'],
  ['showcase', 'Public showcase'],
];
const DEFAULT_HL: Record<string, number> = {
  handoff: 3,
  task_state: 7,
  deployment: 30,
  fact: 60,
  procedure: 120,
  decision: 180,
  failure: 180,
  constraint: 365,
  preference: 365,
};
const BUILTIN = [
  ['private_key_block', 'block'],
  ['sui_private_key', 'block'],
  ['recovery phrase', 'block'],
  ['aws_access_key', 'mask'],
  ['github_token', 'mask'],
  ['slack_token', 'mask'],
  ['stripe_key', 'mask'],
  ['google_api_key', 'mask'],
  ['buiry_token', 'mask'],
  ['jwt', 'mask'],
  ['bearer_token', 'mask'],
  ['cookie_header', 'mask'],
  ['url_credentials', 'mask'],
  ['credential_assignment', 'mask'],
] as const;

export function Settings() {
  const { projectId, base } = useProject();
  const { role } = useWs();
  const q = useQuery(() => api<Proj>(`/v1/projects/${projectId}`), [projectId]);
  const [sec, setSec] = useState<Section>('general');
  const admin = can(role, 'admin');
  return (
    <div className="page">
      <PageHead title="Project settings" />
      {!admin && (
        <div style={{ marginBottom: 16 }}>
          <Banner kind="info">You need Admin access to change settings. They are shown read-only.</Banner>
        </div>
      )}
      <div className="split">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, l]) => (
            <button key={id} aria-current={sec === id} onClick={() => setSec(id)}>
              {l}
            </button>
          ))}
        </nav>
        <div className="grow col" style={{ minWidth: 0 }}>
          <Async q={q} rows={5}>
            {(p) =>
              sec === 'general' ? (
                <General p={p} admin={admin} reload={q.reload} />
              ) : sec === 'memory' ? (
                <MemoryRules p={p} admin={admin} reload={q.reload} />
              ) : sec === 'redaction' ? (
                <Redaction p={p} admin={admin} reload={q.reload} />
              ) : sec === 'verification' ? (
                <VerifSettings p={p} admin={admin} reload={q.reload} />
              ) : sec === 'storage' ? (
                <StorageSettings p={p} admin={admin} reload={q.reload} base={base} />
              ) : sec === 'branches' ? (
                <BranchSettings p={p} admin={admin} reload={q.reload} />
              ) : sec === 'buirymd' ? (
                <BuiryMd />
              ) : (
                <Showcase p={p} admin={admin} reload={q.reload} />
              )
            }
          </Async>
        </div>
      </div>
    </div>
  );
}

function useSave(p: Proj, reload: () => void) {
  const { toast, bump } = useApp();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    save: async (patch: {
      name?: string;
      description?: string;
      networks?: string[];
      settings?: Record<string, unknown>;
    }) => {
      setBusy(true);
      try {
        await api(`/v1/projects/${p.id}`, { method: 'PATCH', body: patch });
        toast('success', 'Saved.');
        reload();
        bump();
      } catch (e) {
        toast('error', (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
  };
}
type P = { p: Proj; admin: boolean; reload: () => void };

function General({ p, admin, reload }: P) {
  const { busy, save } = useSave(p, reload);
  const { toast } = useApp();
  const nav = useNavigate();
  const { wsId, role } = useWs();
  const [name, setName] = useState(p.name);
  const [desc, setDesc] = useState(p.description ?? '');
  const [nets, setNets] = useState(p.networks);
  const [del, setDel] = useState(false);
  return (
    <>
      <Card
        title="General"
        actions={
          <Button
            variant="primary"
            loading={busy}
            disabled={!admin}
            onClick={() => save({ name, description: desc, networks: nets })}
          >
            Save
          </Button>
        }
      >
        <div className="col">
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                className="inp"
                value={name}
                disabled={!admin}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description">
            {(id) => (
              <input
                id={id}
                className="inp"
                value={desc}
                disabled={!admin}
                onChange={(e) => setDesc(e.target.value)}
              />
            )}
          </Field>
          <div className="field">
            <span className="lab">Declared networks</span>
            <div className="row wrap">
              {['sui:mainnet', 'sui:testnet'].map((n) => (
                <label key={n} className="check chip">
                  <input
                    type="checkbox"
                    disabled={!admin}
                    checked={nets.includes(n)}
                    onChange={(e) => setNets(e.target.checked ? [...nets, n] : nets.filter((x) => x !== n))}
                  />
                  {n}
                </label>
              ))}
            </div>
          </div>
          <div className="small muted">
            Default branch: <span className="mono">main</span> (protected)
          </div>
        </div>
      </Card>
      <Card title="Danger zone">
        <div className="spread">
          <div>
            <strong>Archive project</strong>
            <div className="small muted">
              Hides the project and stops agent access. Memories remain in storage.
            </div>
          </div>
          <Button
            variant="danger"
            disabled={role !== 'owner'}
            title={role !== 'owner' ? 'Only the workspace owner can archive a project.' : undefined}
            onClick={() => setDel(true)}
          >
            Archive
          </Button>
        </div>
      </Card>
      <ConfirmModal
        open={del}
        onClose={() => setDel(false)}
        danger
        title="Archive project"
        typeName={p.name}
        confirmLabel="Archive project"
        body="Agents lose access to this project. Type the project name to continue."
        onConfirm={async () => {
          await api(`/v1/projects/${p.id}`, { method: 'DELETE' });
          toast('success', 'Project archived.');
          nav(`/w/${wsId}/projects`);
        }}
      />
    </>
  );
}

function MemoryRules({ p, admin, reload }: P) {
  const { busy, save } = useSave(p, reload);
  const s = p.settings;
  const [ap, setAp] = useState({
    enabled: s.autoPromotion?.enabled ?? true,
    helpfulReports: s.autoPromotion?.helpfulReports ?? 3,
    distinctSessions: s.autoPromotion?.distinctSessions ?? 2,
  });
  const [rt, setRt] = useState<number>(s.reviewThreshold ?? 0.3);
  const [hl, setHl] = useState<Record<string, number>>({ ...DEFAULT_HL, ...(s.halfLives ?? {}) });
  const [tb, setTb] = useState<number>(s.defaultTokenBudget ?? 1500);
  const [prop, setProp] = useState<boolean>(s.allowProposedOnMain ?? true);
  return (
    <Card
      title="Memory rules"
      actions={
        <Button
          variant="primary"
          loading={busy}
          disabled={!admin}
          onClick={() =>
            save({
              settings: {
                autoPromotion: ap,
                reviewThreshold: rt,
                halfLives: hl,
                defaultTokenBudget: tb,
                allowProposedOnMain: prop,
              },
            })
          }
        >
          Save
        </Button>
      }
    >
      <div className="col">
        <Banner kind="info">
          These values are saved with the project. The built-in learning loop currently applies its default
          thresholds and half-lives; per-project overrides are recorded for when it is wired to read them.
        </Banner>
        <label className="check">
          <input
            type="checkbox"
            disabled={!admin}
            checked={prop}
            onChange={(e) => setProp(e.target.checked)}
          />
          Agents may write proposed memories to main
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={!admin}
            checked={ap.enabled}
            onChange={(e) => setAp({ ...ap, enabled: e.target.checked })}
          />
          Auto-promote memories that agents repeatedly report helpful
        </label>
        <div className="grid g2">
          <Field label="Helpful reports needed">
            {(id) => (
              <input
                id={id}
                className="inp"
                type="number"
                min={1}
                disabled={!admin}
                value={ap.helpfulReports}
                onChange={(e) => setAp({ ...ap, helpfulReports: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Distinct sessions needed">
            {(id) => (
              <input
                id={id}
                className="inp"
                type="number"
                min={1}
                disabled={!admin}
                value={ap.distinctSessions}
                onChange={(e) => setAp({ ...ap, distinctSessions: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <Field label={`Needs-review threshold: ${rt.toFixed(2)}`}>
          {(id) => (
            <input
              id={id}
              type="range"
              min={0}
              max={1}
              step={0.05}
              disabled={!admin}
              value={rt}
              onChange={(e) => setRt(Number(e.target.value))}
            />
          )}
        </Field>
        <Field label="Default briefing token budget">
          {(id) => (
            <input
              id={id}
              className="inp"
              type="number"
              min={300}
              max={8000}
              disabled={!admin}
              value={tb}
              onChange={(e) => setTb(Number(e.target.value))}
            />
          )}
        </Field>
        <div className="label">Half-life by type (days)</div>
        <div className="grid g3">
          {MEM_TYPES.map((t) => (
            <Field key={t} label={t.replace('_', ' ')}>
              {(id) => (
                <input
                  id={id}
                  className="inp"
                  type="number"
                  min={1}
                  disabled={!admin}
                  value={hl[t]}
                  onChange={(e) => setHl({ ...hl, [t]: Number(e.target.value) })}
                />
              )}
            </Field>
          ))}
        </div>
        <div>
          <Button size="sm" disabled={!admin} onClick={() => setHl({ ...DEFAULT_HL })}>
            Reset to defaults
          </Button>
        </div>
      </div>
    </Card>
  );
}

interface Custom {
  name: string;
  pattern: string;
  action: 'mask' | 'block';
}
function Redaction({ p, admin, reload }: P) {
  const { busy, save } = useSave(p, reload);
  const r = p.settings.redaction ?? {};
  const [custom, setCustom] = useState<Custom[]>(r.custom ?? []);
  const [emails, setEmails] = useState<boolean>(r.maskEmails ?? true);
  const [phones, setPhones] = useState<boolean>(r.maskPhones ?? true);
  const [test, setTest] = useState('');
  const [draft, setDraft] = useState<Custom>({ name: '', pattern: '', action: 'mask' });
  const hits = custom.flatMap((c) => {
    try {
      return [...test.matchAll(new RegExp(c.pattern, 'g'))].map((m) => ({ c, text: m[0] }));
    } catch {
      return [];
    }
  });
  return (
    <>
      <Card title="Built-in classes">
        <div className="row wrap">
          {BUILTIN.map(([n, a]) => (
            <span
              key={n}
              className="chip s"
              style={{ ['--c' as string]: a === 'block' ? 'var(--s-stale)' : 'var(--s-contested)' }}
            >
              {n}: {a}
            </span>
          ))}
        </div>
        <div className="col mt">
          <label className="check">
            <input
              type="checkbox"
              disabled={!admin}
              checked={emails}
              onChange={(e) => setEmails(e.target.checked)}
            />
            Mask email addresses
          </label>
          <label className="check">
            <input
              type="checkbox"
              disabled={!admin}
              checked={phones}
              onChange={(e) => setPhones(e.target.checked)}
            />
            Mask phone numbers
          </label>
        </div>
        <p className="small muted mt">
          Built-in classes cannot be disabled. Block means the write is refused; mask replaces the text with a
          marker.
        </p>
      </Card>
      <Card
        title="Custom patterns"
        actions={
          <Button
            variant="primary"
            loading={busy}
            disabled={!admin}
            onClick={() =>
              save({ settings: { redaction: { custom, maskEmails: emails, maskPhones: phones } } })
            }
          >
            Save
          </Button>
        }
      >
        {custom.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Expression</th>
                <th>Action</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {custom.map((c, i) => (
                <tr key={i}>
                  <td>{c.name}</td>
                  <td className="mono small">{c.pattern}</td>
                  <td>{c.action}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!admin}
                      onClick={() => setCustom(custom.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row wrap mt" style={{ alignItems: 'flex-end' }}>
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                className="inp"
                value={draft.name}
                disabled={!admin}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Expression">
            {(id) => (
              <input
                id={id}
                className="inp mono"
                value={draft.pattern}
                disabled={!admin}
                onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
              />
            )}
          </Field>
          <Field label="Action">
            {(id) => (
              <select
                id={id}
                className="inp"
                value={draft.action}
                disabled={!admin}
                onChange={(e) => setDraft({ ...draft, action: e.target.value as 'mask' | 'block' })}
              >
                <option>mask</option>
                <option>block</option>
              </select>
            )}
          </Field>
          <Button
            disabled={!admin || !draft.name || !draft.pattern}
            onClick={() => {
              try {
                new RegExp(draft.pattern);
                setCustom([...custom, draft]);
                setDraft({ name: '', pattern: '', action: 'mask' });
              } catch {
                /* invalid expression */
              }
            }}
          >
            Add
          </Button>
        </div>
        <Field
          label="Test text"
          help={
            hits.length
              ? `${hits.length} match${hits.length === 1 ? '' : 'es'}: ${hits.map((h) => `${h.c.name} “${h.text}”`).join(', ')}`
              : 'Type text to preview matches.'
          }
        >
          {(id) => <input id={id} className="inp" value={test} onChange={(e) => setTest(e.target.value)} />}
        </Field>
      </Card>
    </>
  );
}

function VerifSettings({ p, admin, reload }: P) {
  const { busy, save } = useSave(p, reload);
  const [h, setH] = useState<number>(p.settings.driftScanIntervalHours ?? 6);
  return (
    <Card
      title="Verification"
      actions={
        <Button
          variant="primary"
          loading={busy}
          disabled={!admin}
          onClick={() => save({ settings: { driftScanIntervalHours: h } })}
        >
          Save
        </Button>
      }
    >
      <div className="col">
        <Field label="Drift scan interval (hours)" help="How often evidence is rechecked against the chain.">
          {(id) => (
            <input
              id={id}
              className="inp"
              type="number"
              min={1}
              max={168}
              disabled={!admin}
              value={h}
              onChange={(e) => setH(Number(e.target.value))}
            />
          )}
        </Field>
        <div className="small muted">
          Networks: {p.networks.join(', ') || 'none declared'}. Change them under General.
        </div>
      </div>
    </Card>
  );
}

function StorageSettings({ p, admin, reload, base }: P & { base: string }) {
  const { busy, save } = useSave(p, reload);
  const [m, setM] = useState<number>(p.settings.expiryMarginEpochs ?? 2);
  return (
    <Card
      title="Storage"
      actions={
        <Button
          variant="primary"
          loading={busy}
          disabled={!admin}
          onClick={() => save({ settings: { expiryMarginEpochs: m } })}
        >
          Save
        </Button>
      }
    >
      <div className="col">
        <div className="small">
          Account:{' '}
          {p.walrus_account_id ? (
            <span className="mono">{p.walrus_account_id}</span>
          ) : (
            <span className="muted">assigned when the first memory is stored</span>
          )}
          . <a href={`${base}/storage`}>Open storage health</a>
        </div>
        <Field
          label="Expiry alert margin (epochs)"
          help="Alert this many epochs before a stored memory lapses."
        >
          {(id) => (
            <input
              id={id}
              className="inp"
              type="number"
              min={1}
              max={20}
              disabled={!admin}
              value={m}
              onChange={(e) => setM(Number(e.target.value))}
            />
          )}
        </Field>
      </div>
    </Card>
  );
}

function BranchSettings({ p, admin, reload }: P) {
  const { busy, save } = useSave(p, reload);
  const [prop, setProp] = useState<boolean>(p.settings.allowProposedOnMain ?? true);
  return (
    <Card
      title="Branches"
      actions={
        <Button
          variant="primary"
          loading={busy}
          disabled={!admin}
          onClick={() => save({ settings: { allowProposedOnMain: prop } })}
        >
          Save
        </Button>
      }
    >
      <div className="col">
        <p className="small muted">main is protected. Only admins can merge into it.</p>
        <label className="check">
          <input
            type="checkbox"
            disabled={!admin}
            checked={prop}
            onChange={(e) => setProp(e.target.checked)}
          />
          Agents may write proposed memories directly to main
        </label>
      </div>
    </Card>
  );
}

function BuiryMd() {
  const { projectId } = useProject();
  const q = useQuery(
    () => api<{ snapshot: string | null; template: string }>(`/v1/projects/${projectId}/buirymd`),
    [projectId],
    { live: true },
  );
  return (
    <Card title="BUIRY.md">
      <Async q={q} rows={4}>
        {(d) => (
          <div className="col">
            <p className="small muted">
              The file lives in your repository. Commit it so every agent finds the project. The snapshot
              region is regenerated by the worker; edit only the rules above it.
            </p>
            <CodeBlock value={d.template} />
            <div className="label">Snapshot region</div>
            {d.snapshot ? (
              <CodeBlock value={d.snapshot} />
            ) : (
              <p className="small muted">No snapshot yet. It is generated after confirmed memories exist.</p>
            )}
            <p className="small muted">
              Regenerate and write the file locally with <span className="mono">npx buiry sync</span>.
            </p>
          </div>
        )}
      </Async>
    </Card>
  );
}

function Showcase({ p, admin, reload }: P) {
  const { busy, save } = useSave(p, reload);
  const s = p.settings.publicShowcase ?? {};
  const [on, setOn] = useState<boolean>(s.enabled ?? false);
  const [show, setShow] = useState<string[]>(s.show ?? ['counts']);
  useEffect(() => {}, []);
  return (
    <Card
      title="Public showcase"
      actions={
        <Button
          variant="primary"
          loading={busy}
          disabled={!admin}
          onClick={() => save({ settings: { publicShowcase: { enabled: on, show } } })}
        >
          Save
        </Button>
      }
    >
      <div className="col">
        <Banner kind="info">
          The preference is saved with the project. The public viewer page is not part of this build, so
          nothing is published yet.
        </Banner>
        <label className="check">
          <input type="checkbox" disabled={!admin} checked={on} onChange={(e) => setOn(e.target.checked)} />
          Allow a read-only public page
        </label>
        {[
          ['counts', 'Counts by type and status'],
          ['memories', 'Selected memories'],
          ['evidence', 'Evidence'],
          ['storage', 'Storage links'],
        ].map(([k, l]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              disabled={!admin || !on}
              checked={show.includes(k!)}
              onChange={(e) => setShow(e.target.checked ? [...show, k!] : show.filter((x) => x !== k))}
            />
            {l}
          </label>
        ))}
      </div>
    </Card>
  );
}
