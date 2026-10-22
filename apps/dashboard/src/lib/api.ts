/** Typed access to the Buiry REST API. Sessions travel as an HttpOnly cookie; a pasted bearer token is also accepted. */
export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; retryAfterMs?: number; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'buiry.token';
export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(v: string | null): void {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: the cookie session still works */
    }
  },
};

export function authHeaders(): Record<string, string> {
  const t = tokenStore.get();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export async function api<T>(
  path: string,
  o: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: o.method ?? 'GET',
      credentials: 'include',
      headers: { ...authHeaders(), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('network', 'Could not reach the Buiry service.', 0);
  }
  const text = await res.text();
  let json: Envelope<T> | undefined;
  try {
    json = text ? (JSON.parse(text) as Envelope<T>) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok || !json?.ok) {
    throw new ApiError(
      json?.error?.code ?? (res.status === 401 ? 'unauthorized' : 'internal'),
      json?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      res.headers.get('x-request-id') ?? undefined,
    );
  }
  return json.data as T;
}

export const qs = (o: Record<string, string | number | boolean | undefined | string[]>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === '' || v === false) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Server-sent events over fetch, so a bearer token works as well as the cookie. */
export function openStream(
  path: string,
  on: {
    event: (name: string, data: unknown, id?: string) => void;
    state: (s: 'on' | 'retry' | 'off') => void;
  },
): () => void {
  let stop = false;
  const ctl = new AbortController();
  let lastId: string | undefined;
  const run = async () => {
    let delay = 1000;
    while (!stop) {
      try {
        const res = await fetch(
          path + (lastId ? `${path.includes('?') ? '&' : '?'}after=${encodeURIComponent(lastId)}` : ''),
          {
            credentials: 'include',
            headers: { ...authHeaders(), accept: 'text/event-stream' },
            signal: ctl.signal,
          },
        );
        if (!res.ok || !res.body) throw new Error(String(res.status));
        on.state('on');
        delay = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let name = 'message';
            let id: string | undefined;
            const data: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            if (id) lastId = id;
            if (name === 'ping') continue;
            try {
              on.event(name, JSON.parse(data.join('\n')), id);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch {
        if (stop) return;
      }
      on.state('retry');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  };
  void run();
  return () => {
    stop = true;
    ctl.abort();
    on.state('off');
  };
}
