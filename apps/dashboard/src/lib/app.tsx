import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, openStream } from './api';
import type { Me, Role } from './types';

/* ---------- theme ---------- */
type Theme = 'dark' | 'light';
const THEME_KEY = 'buiry.theme';
function initialTheme(): Theme {
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === 'dark' || s === 'light') return s;
  } catch {
    /* ignore */
  }
  return 'dark';
}

/* ---------- toasts ---------- */
export interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
  action?: { label: string; run: () => void };
}

interface Ctx {
  me: Me | null;
  refreshMe: () => Promise<void>;
  signOut: () => Promise<void>;
  theme: Theme;
  toggleTheme: () => void;
  toasts: ToastItem[];
  toast: (kind: ToastItem['kind'], text: string, action?: ToastItem['action']) => void;
  dismiss: (id: number) => void;
  live: 'on' | 'retry' | 'off';
  setLive: (s: 'on' | 'retry' | 'off') => void;
  tick: number;
  bump: () => void;
  collapsed: boolean;
  setCollapsed: (b: boolean) => void;
  palette: boolean;
  setPalette: (b: boolean) => void;
}
const C = createContext<Ctx | null>(null);
export const useApp = (): Ctx => {
  const c = useContext(C);
  if (!c) throw new Error('outside AppProvider');
  return c;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [live, setLive] = useState<'on' | 'retry' | 'off'>('off');
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const nid = useRef(1);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/v1/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);
  const signOut = useCallback(async () => {
    try {
      await api('/v1/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* already signed out */
    }
    setMe(null);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind: ToastItem['kind'], text: string, action?: ToastItem['action']) => {
      const id = nid.current++;
      setToasts((t) => [...t, { id, kind, text, ...(action ? { action } : {}) }]);
      if (kind !== 'error') setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const v = useMemo<Ctx>(
    () => ({
      me,
      refreshMe,
      signOut,
      theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      toasts,
      toast,
      dismiss,
      live,
      setLive,
      tick,
      bump,
      collapsed,
      setCollapsed,
      palette,
      setPalette,
    }),
    [me, refreshMe, signOut, theme, toasts, toast, dismiss, live, tick, bump, collapsed, palette],
  );
  return <C.Provider value={v}>{children}</C.Provider>;
}

/* ---------- permission helpers ---------- */
const RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2, owner: 3 };
export const can = (role: Role | undefined, need: Role): boolean => !!role && RANK[role] >= RANK[need];

/* ---------- data hook ---------- */
export interface Query<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}
/** Fetches on mount and whenever deps change; reloads when live events arrive (`live: true`) or on an interval. */
export function useQuery<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  o: { live?: boolean; refreshMs?: number } = {},
): Query<T> {
  const { tick } = useApp();
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [manual, setManual] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const liveTick = o.live ? tick : 0;
  useEffect(() => {
    const mine = ++seq.current;
    fnRef
      .current()
      .then((data) => mine === seq.current && setState({ data, loading: false }))
      .catch(
        (e) =>
          mine === seq.current &&
          setState((s) => ({
            ...s,
            error: e instanceof ApiError ? e : new ApiError('internal', String(e), 0),
            loading: false,
          })),
      );
  }, [...deps, manual, liveTick]);
  useEffect(() => {
    if (!o.refreshMs) return;
    const t = setInterval(() => setManual((m) => m + 1), o.refreshMs);
    return () => clearInterval(t);
  }, [o.refreshMs]);
  const reload = useCallback(() => setManual((m) => m + 1), []);
  return { data: state.data, error: state.error, loading: state.loading && state.data === undefined, reload };
}

/** Subscribes to a project's activity stream; reports connection state and triggers live reloads. */
export function useProjectStream(projectId: string | undefined, onActivity?: (row: unknown) => void): void {
  const { setLive, bump } = useApp();
  const cb = useRef(onActivity);
  cb.current = onActivity;
  useEffect(() => {
    if (!projectId) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const stop = openStream(`/v1/projects/${projectId}/activity/stream`, {
      state: setLive,
      event: (name, data) => {
        if (name !== 'activity') return;
        cb.current?.(data);
        clearTimeout(t);
        t = setTimeout(bump, 250);
      },
    });
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [projectId, setLive, bump]);
}

export function useKey(keys: string, fn: (e: KeyboardEvent) => void, deps: unknown[] = []): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const combo = `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.key.toLowerCase()}`;
      if (keys.split(',').includes(combo) && (!typing || combo.startsWith('mod+') || combo === 'escape'))
        fn(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, deps);
}
