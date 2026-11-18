import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

/**
 * Compression for the dashboard's static files (Phase 2.4). Text assets are compressed once per file version and
 * kept in memory: the build is a handful of files (about 430 KiB of text before compression), and hashed assets never
 * change while the process runs. Fonts and images are already compressed and are sent as they are.
 */
export type Encoding = 'br' | 'gzip';

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.map']);
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

export function isCompressible(ext: string): boolean {
  return COMPRESSIBLE.has(ext.toLowerCase());
}

/** Picks brotli, then gzip, from an Accept-Encoding header; an encoding with q=0 is refused. */
export function chooseEncoding(accept: string | string[] | undefined): Encoding | undefined {
  const raw = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  const q = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    q.set(name, qp ? Number(qp.slice(2)) || 0 : 1);
  }
  const ok = (e: string) => (q.get(e) ?? q.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return undefined;
}

const cache = new Map<string, Promise<Buffer>>();

/** The compressed bytes of `file`, cached per path, encoding, size and modification time. */
export async function compressedFile(file: string, encoding: Encoding): Promise<Buffer> {
  const s = await stat(file);
  const key = `${encoding}:${s.size}:${s.mtimeMs}:${file}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = readFile(file).then((b) =>
      encoding === 'br'
        ? brotli(b, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 9,
              [constants.BROTLI_PARAM_SIZE_HINT]: b.length,
            },
          })
        : gz(b, { level: 9 }),
    );
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}
