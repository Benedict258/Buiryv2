import { useState } from 'react';
import { api } from '../lib/api';
import { can, useApp, useQuery } from '../lib/app';
import { useProject, useWs } from '../lib/ctx';
import { dateOnly } from '../lib/format';
import type { ProjectStorageView } from '../lib/types';
import { Banner, Button, Card, ConfirmModal, Field, IdBlock } from '../components/ui';

/**
 * Bring your own Walrus Memory account. The delegate key is write-only: it is sent once over the API, sealed on the
 * server, and never shown again (only its public half is).
 */
export function StorageAccountCard({
  storedMemories,
  onChange,
}: {
  storedMemories: number;
  onChange: () => void;
}) {
  const { projectId } = useProject();
  const { role } = useWs();
  const { toast } = useApp();
  const admin = can(role, 'admin');
  const q = useQuery(() => api<ProjectStorageView>(`/v1/projects/${projectId}/storage/account`), [projectId]);
  const v = q.data;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ relayerUrl: '', network: 'testnet', accountId: '', delegateKey: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState(false);

  const start = () => {
    setForm({
      relayerUrl: v?.relayerUrl ?? '',
      network: v?.network ?? 'testnet',
      accountId: v?.accountId ?? '',
      delegateKey: '',
    });
    setErr(null);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/v1/projects/${projectId}/storage/account`, { method: 'PUT', body: form });
      toast('success', v?.mode === 'byo' ? 'Storage account updated.' : 'Own storage account connected.');
      setEditing(false);
      setForm((f) => ({ ...f, delegateKey: '' }));
      q.reload();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card
      title="Account"
      actions={
        admin && !editing ? (
          <span className="row">
            <Button size="sm" onClick={start}>
              {v?.mode === 'byo' ? 'Rotate key or edit' : 'Use your own account'}
            </Button>
            {v?.mode === 'byo' && (
              <Button
                size="sm"
                variant="danger"
                disabled={storedMemories > 0}
                onClick={() => setDisconnect(true)}
              >
                Disconnect
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      {v && !v.managedAllowed && v.mode === 'managed' && (
        <Banner kind="warning">
          This deployment&apos;s shared account serves another workspace. Connect this project&apos;s own
          Walrus Memory account before agents can store memories.
        </Banner>
      )}
      {!editing ? (
        <dl className="col small" style={{ margin: 0 }}>
          <div className="spread">
            <dt className="muted">Mode</dt>
            <dd style={{ margin: 0 }}>
              <span className="chip">{v ? (v.mode === 'byo' ? 'own account' : 'managed') : '…'}</span>
            </dd>
          </div>
          {v?.mode === 'byo' && (
            <>
              <div className="spread">
                <dt className="muted">Storage account</dt>
                <dd style={{ margin: 0 }}>
                  <IdBlock value={v.accountId!} />
                </dd>
              </div>
              <div className="spread">
                <dt className="muted">Network</dt>
                <dd style={{ margin: 0 }}>sui:{v.network}</dd>
              </div>
              <div className="spread">
                <dt className="muted">Relayer</dt>
                <dd style={{ margin: 0 }} className="mono">
                  {v.relayerUrl}
                </dd>
              </div>
              <div className="spread">
                <dt className="muted">Delegate public key</dt>
                <dd style={{ margin: 0 }}>
                  <IdBlock value={v.delegatePublicKey!} />
                </dd>
              </div>
              <div className="spread">
                <dt className="muted">Updated</dt>
                <dd style={{ margin: 0 }}>{dateOnly(v.updatedAt ?? null)}</dd>
              </div>
            </>
          )}
          <div className="spread">
            <dt className="muted">Stored memories</dt>
            <dd style={{ margin: 0 }}>{storedMemories}</dd>
          </div>
        </dl>
      ) : (
        <div className="col">
          <p className="small muted" style={{ margin: 0 }}>
            Memories for this project are stored in this account. Changing to a different account is only
            possible before anything is stored; a new delegate key for the same account can be set at any
            time.
          </p>
          <Field label="Relayer URL">
            {(id) => (
              <input
                id={id}
                className="inp"
                value={form.relayerUrl}
                placeholder="https://"
                onChange={set('relayerUrl')}
              />
            )}
          </Field>
          <Field label="Network">
            {(id) => (
              <select id={id} className="inp" value={form.network} onChange={set('network')}>
                <option value="testnet">sui:testnet</option>
                <option value="mainnet">sui:mainnet</option>
              </select>
            )}
          </Field>
          <Field label="Account id">
            {(id) => (
              <input
                id={id}
                className="inp mono"
                value={form.accountId}
                placeholder="0x"
                onChange={set('accountId')}
              />
            )}
          </Field>
          <Field
            label="Delegate private key"
            help="Sent once and stored encrypted. It is never shown again; only its public half is."
          >
            {(id) => (
              <input
                id={id}
                className="inp mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={form.delegateKey}
                onChange={set('delegateKey')}
              />
            )}
          </Field>
          {err && <Banner kind="error">{err}</Banner>}
          <div className="row">
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.relayerUrl || !form.accountId || !form.delegateKey}
              onClick={save}
            >
              Check and save
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setForm((f) => ({ ...f, delegateKey: '' }));
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <ConfirmModal
        open={disconnect}
        onClose={() => setDisconnect(false)}
        danger
        title="Disconnect own account"
        confirmLabel="Disconnect"
        body="The project goes back to the deployment's shared account. Its sealed delegate key is deleted."
        onConfirm={async () => {
          await api(`/v1/projects/${projectId}/storage/account`, { method: 'DELETE' });
          toast('success', 'Own storage account disconnected.');
          q.reload();
          onChange();
        }}
      />
    </Card>
  );
}
