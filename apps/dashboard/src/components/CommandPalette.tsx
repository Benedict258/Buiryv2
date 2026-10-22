import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useApp, useKey } from '../lib/app';
import { WsContext } from '../lib/ctx';
import type { Memory } from '../lib/types';
import { cx } from './ui';

interface Item {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

const SCREENS = [
  'overview',
  'memory',
  'timeline',
  'branches',
  'agents',
  'activity',
  'alerts',
  'verification',
  'handoffs',
  'briefing',
  'packs',
  'storage',
  'settings',
];

export function CommandPalette() {
  const { palette, setPalette, toggleTheme, theme } = useApp();
  const ws = useContext(WsContext);
  const { ws: wsId, pid } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [mems, setMems] = useState<Memory[]>([]);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useKey(
    'mod+k',
    (e) => {
      e.preventDefault();
      setPalette(true);
    },
    [],
  );
  useKey('escape', () => setPalette(false), []);
  useEffect(() => {
    if (palette) {
      setQ('');
      setIdx(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [palette]);
  useEffect(() => {
    if (!palette || !pid || q.trim().length < 2) {
      setMems([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ items: Memory[] }>(`/v1/projects/${pid}/memories${qs({ q, limit: 5 })}`)
        .then((r) => setMems(r.items))
        .catch(() => setMems([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, palette, pid]);
  const go = (to: string) => () => {
    setPalette(false);
    nav(to);
  };
  const items = useMemo<Item[]>(() => {
    const all: Item[] = [];
    for (const m of mems)
      all.push({
        group: 'Memories',
        label: m.text.slice(0, 80),
        hint: m.type,
        run: go(`/w/${wsId}/p/${pid}/memory?memory=${m.id}`),
      });
    for (const p of ws?.projects.data ?? [])
      all.push({
        group: 'Projects',
        label: p.name,
        hint: 'Open project',
        run: go(`/w/${wsId}/p/${p.id}/overview`),
      });
    if (pid)
      for (const s of SCREENS)
        all.push({
          group: 'Go to',
          label: s[0]!.toUpperCase() + s.slice(1),
          run: go(`/w/${wsId}/p/${pid}/${s}`),
        });
    all.push({
      group: 'Actions',
      label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
      run: () => {
        toggleTheme();
        setPalette(false);
      },
    });
    if (pid)
      all.push({
        group: 'Actions',
        label: 'Connect an agent',
        run: go(`/w/${wsId}/p/${pid}/agents?connect=1`),
      });
    all.push({ group: 'Actions', label: 'New project', run: go(`/w/${wsId}/projects?new=1`) });
    all.push({ group: 'Actions', label: 'Create API token', run: go(`/w/${wsId}/api`) });
    const n = q.trim().toLowerCase();
    return n
      ? all.filter((i) => i.group === 'Memories' || i.label.toLowerCase().includes(n))
      : all.filter((i) => i.group !== 'Memories');
  }, [q, mems, ws?.projects.data, pid, wsId, theme]);
  if (!palette) return null;
  const run = (i: number) => items[i]?.run();
  let last = '';
  return (
    <>
      <div className="scrim" onClick={() => setPalette(false)} aria-hidden />
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="mh" style={{ padding: 8 }}>
          <input
            ref={input}
            className="inp"
            style={{ border: 0 }}
            placeholder="Search memories, jump to a screen, run an action"
            aria-label="Search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(items.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') run(idx);
            }}
          />
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', padding: 4 }} role="listbox">
          {items.length === 0 && <div className="empty small">No matches</div>}
          {items.map((it, i) => {
            const head =
              it.group !== last ? (
                <div key={`h${it.group}`} className="label" style={{ padding: '8px 12px 2px' }}>
                  {it.group}
                </div>
              ) : null;
            last = it.group;
            return (
              <div key={`${it.group}${i}`}>
                {head}
                <button
                  role="option"
                  aria-selected={i === idx}
                  className={cx('btn ghost')}
                  style={{
                    width: '100%',
                    justifyContent: 'space-between',
                    background: i === idx ? 'var(--brand-subtle)' : undefined,
                  }}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(i)}
                >
                  <span className="trunc">{it.label}</span>
                  <span className="faint small">{it.hint}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="mf small faint" style={{ justifyContent: 'flex-start' }}>
          ↑↓ to move · Enter to run · Esc to close
        </div>
      </div>
    </>
  );
}
