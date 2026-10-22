import { useEffect, useMemo, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { api } from '../lib/api';
import { useQuery } from '../lib/app';
import { useProject } from '../lib/ctx';
import { ago, exact } from '../lib/format';
import type { Activity, Status, MemType } from '../lib/types';
import {
  Async,
  AgentBadge,
  Button,
  Card,
  Empty,
  PageHead,
  Segmented,
  StatusChip,
  TypeChip,
} from '../components/ui';

interface Replay {
  at: string;
  counts: { total: number; byStatus: Record<string, number> };
  memories: {
    id: string;
    type: MemType;
    status: Status;
    branch: string;
    text: string;
    changedSince: boolean;
  }[];
}

export function Timeline() {
  const { projectId, openMemory } = useProject();
  const acts = useQuery(
    () => api<{ items: Activity[] }>(`/v1/projects/${projectId}/activity?limit=200`),
    [projectId],
    { live: true },
  );
  const items = useMemo(
    () => [...(acts.data?.items ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    [acts.data],
  );
  const start = items[0] ? Date.parse(items[0].created_at) - 1000 : Date.now() - 3600_000;
  const end = Date.now();
  const [pos, setPos] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [lens, setLens] = useState<'events' | 'briefings'>('events');
  const at = Math.round(start + (end - start) * pos);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(
      () =>
        setPos((p) => {
          if (p >= 1) {
            setPlaying(false);
            return 1;
          }
          return Math.min(1, p + 0.01 * speed);
        }),
      200,
    );
    return () => clearInterval(t);
  }, [playing, speed]);
  const [debounced, setDebounced] = useState(at);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(at), 150);
    return () => clearTimeout(t);
  }, [at]);
  const replay = useQuery(
    () =>
      api<Replay>(
        `/v1/projects/${projectId}/replay?at=${encodeURIComponent(new Date(debounced).toISOString())}`,
      ),
    [projectId, debounced],
  );

  const bins = 48;
  const hist = Array.from({ length: bins }, () => 0);
  for (const a of items)
    hist[Math.min(bins - 1, Math.floor(((Date.parse(a.created_at) - start) / (end - start)) * bins))]!++;
  const maxBin = Math.max(1, ...hist);
  const visible = items.filter((a) => Date.parse(a.created_at) <= at).reverse();
  const days = new Map<string, Activity[]>();
  for (const a of lens === 'briefings'
    ? visible.filter((v) => v.operation === 'check' || v.operation === 'connect')
    : visible) {
    const d = a.created_at.slice(0, 10);
    days.set(d, [...(days.get(d) ?? []), a]);
  }

  return (
    <div className="page wide">
      <PageHead title="Timeline" desc="What the project knew at any moment, and how it changed." />
      <Card>
        <div className="row" style={{ gap: 12 }}>
          <Button
            aria-label={playing ? 'Pause' : 'Play'}
            icon={playing ? <Pause size={14} /> : <Play size={14} />}
            onClick={() => {
              if (pos >= 1) setPos(0);
              setPlaying(!playing);
            }}
          />
          <select
            className="inp"
            style={{ width: 'auto' }}
            aria-label="Speed"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
          <Button
            variant="ghost"
            onClick={() => {
              setPos(1);
              setPlaying(false);
            }}
          >
            Jump to now
          </Button>
          <span className="mono small muted" style={{ marginLeft: 'auto' }}>
            {exact(new Date(at).toISOString())}
          </span>
        </div>
        <div className="row mt-s" style={{ alignItems: 'flex-end', height: 40, gap: 1 }} aria-hidden>
          {hist.map((h, i) => (
            <i
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(2, (h / maxBin) * 100)}%`,
                background: i / bins <= pos ? 'var(--brand)' : 'var(--border-default)',
              }}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={pos}
          aria-label="Time"
          onChange={(e) => {
            setPos(Number(e.target.value));
            setPlaying(false);
          }}
          style={{ width: '100%' }}
        />
      </Card>
      <div className="grid g2 mt">
        <Card title="Project state at this time">
          <Async q={replay} rows={5}>
            {(r) =>
              r.counts.total === 0 ? (
                <Empty text="The project had no memories at this time." />
              ) : (
                <div className="col">
                  <div className="row wrap small">
                    {Object.entries(r.counts.byStatus).map(([s, n]) => (
                      <span key={s} className="row" style={{ gap: 4 }}>
                        <StatusChip status={s as Status} />
                        {n}
                      </span>
                    ))}
                  </div>
                  {r.memories.map((m) => (
                    <button
                      key={m.id}
                      className="btn ghost"
                      style={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        whiteSpace: 'normal',
                        alignItems: 'flex-start',
                      }}
                      onClick={() => openMemory(m.id)}
                    >
                      <StatusChip status={m.status} />
                      <TypeChip type={m.type} />
                      <span className="grow clamp2">{m.text}</span>
                      {m.changedSince && (
                        <span className="chip" title="Changed since this time">
                          changed
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )
            }
          </Async>
        </Card>
        <Card
          title="Events"
          actions={
            <Segmented
              label="Lens"
              value={lens}
              onChange={setLens}
              items={[
                { id: 'events', label: 'Events' },
                { id: 'briefings', label: 'What agents were shown' },
              ]}
            />
          }
        >
          {days.size === 0 ? (
            <Empty text="No events up to this time." />
          ) : (
            [...days.entries()].map(([day, evs]) => (
              <div key={day} className="mt-s">
                <div className="label">{day}</div>
                <div className="timeline mt-s">
                  {evs.map((a) => (
                    <div className="ev" key={a.id}>
                      <div className="row small">
                        <AgentBadge name={a.actor_id ?? 'system'} />
                        <strong>{a.operation}</strong>
                        <span className="muted">{a.result}</span>
                        <span className="faint" style={{ marginLeft: 'auto' }}>
                          {ago(a.created_at)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
          <p className="faint small mt">Detailed signals are kept for the retention period of your plan.</p>
        </Card>
      </div>
    </div>
  );
}
