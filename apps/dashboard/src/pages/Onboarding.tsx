import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, openStream } from '../lib/api';
import { useApp } from '../lib/app';
import { Banner, Button, CodeBlock, Field, Segmented, TokenReveal } from '../components/ui';
import type { Activity } from '../lib/types';

const STEPS = ['Workspace', 'Project', 'Install', 'Connect an agent', 'First session'];
const NETS = ['sui:mainnet', 'sui:testnet'];
const TOOLS = [
  ['claude-code', 'Claude Code'],
  ['opencode', 'OpenCode'],
  ['cursor', 'Cursor'],
  ['codex', 'Codex'],
  ['other', 'Other MCP client'],
] as const;
const STORAGE = [
  [
    'managed',
    'Managed',
    'We hold the storage account for you.',
    'The storage relayer can read memory text while processing it.',
  ],
  [
    'byo',
    'Bring your own account',
    'You own the storage account; requires a connected wallet.',
    'You control the account; the relayer still sees text while processing.',
  ],
  [
    'self_hosted',
    'Self-hosted relayer',
    'Advanced.',
    'You run the relayer; Buiry never sees the plaintext path.',
  ],
] as const;

export function Onboarding() {
  const { me, refreshMe, toast } = useApp();
  const nav = useNavigate();
  const key = 'buiry.onboarding';
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? '{}') as { step?: number; ws?: string; pid?: string };
    } catch {
      return {};
    }
  })();
  const [step, setStep] = useState(saved.step ?? 0);
  const [ws, setWs] = useState<string | undefined>(saved.ws);
  const [pid, setPid] = useState<string | undefined>(saved.pid);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ step, ws, pid }));
    } catch {
      /* ignore */
    }
  }, [step, ws, pid]);

  const [wsName, setWsName] = useState(me?.displayName ? `${me.displayName}'s workspace` : '');
  const [kind, setKind] = useState<'personal' | 'team'>('personal');
  const [pname, setPname] = useState('');
  const [desc, setDesc] = useState('');
  const [nets, setNets] = useState<string[]>(['sui:mainnet']);
  // Start from the deployment's own network: a testnet server refuses projects that declare sui:mainnet.
  const netsTouched = useRef(false);
  useEffect(() => {
    api<{ network?: string }>('/v1/healthz')
      .then((h) => {
        if (h.network && !netsTouched.current) setNets([`sui:${h.network}`]);
      })
      .catch(() => {});
  }, []);
  const [mode, setMode] = useState<(typeof STORAGE)[number][0]>('managed');
  const [pm, setPm] = useState<'npm' | 'pnpm' | 'yarn' | 'bun'>('npm');
  const [tool, setTool] = useState<string>('claude-code');
  const [agent, setAgent] = useState<{ token: string } | null>(null);
  const [checks, setChecks] = useState<{ label: string; ok: boolean; hint?: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [feed, setFeed] = useState<Activity[]>([]);
  const first = useRef(false);

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const origin = window.location.origin;
  const exec = { npm: 'npx buiry', pnpm: 'pnpm dlx buiry', yarn: 'yarn dlx buiry', bun: 'bunx buiry' }[pm];

  useEffect(() => {
    if (step !== 4 || !pid) return;
    return openStream(`/v1/projects/${pid}/activity/stream`, {
      state: () => {},
      event: (n, d) => {
        if (n !== 'activity') return;
        const a = d as Activity;
        setFeed((f) => [a, ...f].slice(0, 12));
        if (a.operation === 'remember') first.current = true;
      },
    });
  }, [step, pid]);

  return (
    <div className="auth-wrap" style={{ alignItems: 'flex-start', paddingTop: 48 }}>
      <div className="wizard">
        <div className="stepper" role="list" aria-label="Progress">
          {STEPS.map((s, i) => (
            <div
              key={s}
              role="listitem"
              aria-current={i === step ? 'step' : undefined}
              className={`st${i <= step ? ' done' : ''}`}
              title={s}
            />
          ))}
        </div>
        <div className="card col" style={{ gap: 16 }}>
          <div className="label">
            Step {step + 1} of {STEPS.length}
          </div>
          <h2>{STEPS[step]}</h2>
          {err && <Banner kind="error">{err}</Banner>}

          {step === 0 && (
            <>
              <Field label="Workspace name">
                {(id) => (
                  <input
                    id={id}
                    className="inp"
                    value={wsName}
                    onChange={(e) => setWsName(e.target.value)}
                    autoFocus
                  />
                )}
              </Field>
              <Segmented
                label="Kind"
                value={kind}
                onChange={setKind}
                items={[
                  { id: 'personal', label: 'Personal' },
                  { id: 'team', label: 'Team' },
                ]}
              />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                {me && me.workspaces.length > 0 ? (
                  <Button variant="ghost" onClick={() => nav('/')}>
                    Use an existing workspace
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!wsName.trim()}
                  onClick={() =>
                    wrap(async () => {
                      const w = await api<{ id: string }>('/v1/workspaces', {
                        method: 'POST',
                        body: { name: wsName.trim() },
                      });
                      setWs(w.id);
                      await refreshMe();
                      setStep(1);
                    })
                  }
                >
                  Continue
                </Button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <Field label="Project name">
                {(id) => (
                  <input
                    id={id}
                    className="inp"
                    value={pname}
                    onChange={(e) => setPname(e.target.value)}
                    autoFocus
                  />
                )}
              </Field>
              <Field label="Description (optional)">
                {(id) => (
                  <input
                    id={id}
                    className="inp"
                    value={desc}
                    maxLength={500}
                    onChange={(e) => setDesc(e.target.value)}
                  />
                )}
              </Field>
              <div className="field">
                <span className="lab">Declared networks</span>
                <div className="row wrap">
                  {NETS.map((n) => (
                    <label key={n} className="check chip">
                      <input
                        type="checkbox"
                        checked={nets.includes(n)}
                        onChange={(e) => {
                          netsTouched.current = true;
                          setNets(e.target.checked ? [...nets, n] : nets.filter((x) => x !== n));
                        }}
                      />
                      {n}
                    </label>
                  ))}
                </div>
              </div>
              <div className="field" role="radiogroup" aria-label="Storage">
                <span className="lab">Storage</span>
                {STORAGE.map(([id, name, d, trust]) => (
                  <div
                    key={id}
                    className="radio-card"
                    role="radio"
                    aria-checked={mode === id}
                    tabIndex={0}
                    onClick={() => setMode(id)}
                    onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && setMode(id)}
                  >
                    <input type="radio" checked={mode === id} readOnly tabIndex={-1} aria-hidden />
                    <div>
                      <strong>
                        {name}
                        {id === 'managed' ? ' (recommended)' : ''}
                      </strong>
                      <div className="small muted">{d}</div>
                      <div className="small faint">{trust}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="spread">
                <Button variant="ghost" onClick={() => setStep(0)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!pname.trim() || !ws}
                  onClick={() =>
                    wrap(async () => {
                      const p = await api<{ id: string }>(`/v1/workspaces/${ws}/projects`, {
                        method: 'POST',
                        body: {
                          name: pname.trim(),
                          ...(desc ? { description: desc } : {}),
                          networks: nets,
                          walrusMode: mode,
                        },
                      });
                      setPid(p.id);
                      setStep(2);
                    })
                  }
                >
                  Create project
                </Button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <Segmented
                label="Package manager"
                value={pm}
                onChange={setPm}
                items={['npm', 'pnpm', 'yarn', 'bun'].map((x) => ({ id: x as typeof pm, label: x }))}
              />
              <CodeBlock value={`${exec} login --api ${origin}`} />
              <CodeBlock value={`${exec} init --project ${pid ?? '<project>'}`} />
              <p className="small muted">
                This creates BUIRY.md in your repository. It never contains secrets.
              </p>
              <ProjectFileWatch pid={pid} />
              <div className="spread">
                <Button variant="ghost" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => setStep(3)}>
                  Continue
                </Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="row wrap">
                {TOOLS.map(([id, label]) => (
                  <Button
                    key={id}
                    variant={tool === id ? 'primary' : 'secondary'}
                    onClick={() => setTool(id)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <CodeBlock value={`${exec} connect ${tool === 'other' ? '--print' : tool}`} />
              {!agent ? (
                <Button
                  loading={busy}
                  onClick={() =>
                    wrap(async () => {
                      const r = await api<{ token: string }>(`/v1/projects/${pid}/agents`, {
                        method: 'POST',
                        body: { name: tool, tool, permissions: ['read', 'write'] },
                      });
                      setAgent(r);
                    })
                  }
                >
                  Create an agent token for manual setup
                </Button>
              ) : (
                <>
                  <TokenReveal token={agent.token} />
                  <div className="label">Manual configuration</div>
                  <CodeBlock
                    value={JSON.stringify(
                      {
                        mcpServers: {
                          buiry: {
                            type: 'http',
                            url: `${origin}/mcp`,
                            headers: { Authorization: 'Bearer <token>' },
                          },
                        },
                      },
                      null,
                      2,
                    )}
                  />
                  <Button
                    loading={busy}
                    onClick={() =>
                      wrap(async () => {
                        const res = await fetch('/v1/agent/project', {
                          method: 'POST',
                          headers: {
                            authorization: `Bearer ${agent.token}`,
                            'content-type': 'application/json',
                          },
                          body: '{}',
                        });
                        const st = await api<{ gateway: { state: string }; relayer: { state: string } }>(
                          `/v1/projects/${pid}/status`,
                        );
                        setChecks([
                          {
                            label: 'Token is valid',
                            ok: res.ok,
                            hint: 'Create a new token and paste it unchanged.',
                          },
                          { label: 'Project found', ok: res.ok },
                          {
                            label: 'Storage relayer reachable',
                            ok: !['unreachable', 'paused'].includes(st.relayer.state),
                            hint: 'Memories are queued until storage returns.',
                          },
                          {
                            label: 'Chain gateway reachable',
                            ok: st.gateway.state !== 'unconfigured',
                            hint: 'Evidence checks stay unknown until a Tatum key is set.',
                          },
                        ]);
                      })
                    }
                  >
                    Test connection
                  </Button>
                  {checks && (
                    <ul
                      className="col"
                      style={{ listStyle: 'none', padding: 0, margin: 0 }}
                      aria-live="polite"
                    >
                      {checks.map((c) => (
                        <li key={c.label} className="row">
                          {c.ok ? (
                            <CheckCircle2 size={16} style={{ color: 'var(--s-confirmed)' }} />
                          ) : (
                            <XCircle size={16} style={{ color: 'var(--s-stale)' }} />
                          )}
                          <span>{c.label}</span>
                          {!c.ok && c.hint && <span className="small muted">{c.hint}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <div className="spread">
                <Button variant="ghost" onClick={() => setStep(2)}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => setStep(4)}>
                  Continue
                </Button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Start a session in your agent. It calls check and gets a briefing.</li>
                <li>As it works, it writes memories with evidence.</li>
                <li>Review them here and confirm what is right.</li>
              </ol>
              <div className="card" aria-live="polite">
                <div className="label">Live feed</div>
                {feed.length === 0 ? (
                  <p className="small muted mt-s">Waiting for the first event…</p>
                ) : (
                  feed.map((a) => (
                    <div key={a.id} className="small row mt-s">
                      <span className="mono">{a.actor_id ?? 'system'}</span>
                      <span>{a.operation}</span>
                      <span className="faint">{a.result}</span>
                    </div>
                  ))
                )}
              </div>
              {feed.some((a) => a.operation === 'remember') && (
                <Banner kind="success">First memory arrived.</Banner>
              )}
              <div className="spread">
                <Button variant="ghost" onClick={() => setStep(3)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(key);
                    } catch {
                      /* ignore */
                    }
                    toast('success', 'Project ready.');
                    nav(`/w/${ws}/p/${pid}/overview`);
                  }}
                >
                  Open project
                </Button>
              </div>
            </>
          )}
        </div>
        {step >= 2 && step <= 3 && (
          <p className="center small faint" style={{ textAlign: 'center', marginTop: 8 }}>
            You can skip ahead; everything here is also in project settings.
          </p>
        )}
      </div>
    </div>
  );
}

function ProjectFileWatch({ pid }: { pid?: string }) {
  const [state, setState] = useState<'wait' | 'ok'>('wait');
  useEffect(() => {
    if (!pid) return;
    return openStream(`/v1/projects/${pid}/activity/stream`, {
      state: () => {},
      event: (n, d) => {
        if (n === 'activity' && ['connect', 'init'].includes((d as Activity).operation)) setState('ok');
      },
    });
  }, [pid]);
  return (
    <span className="pill" role="status">
      {state === 'ok' ? 'Project file detected' : 'Waiting for init'}
    </span>
  );
}
