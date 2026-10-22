/**
 * Writes a set of realistic project memories through the normal write path, waits until they are stored on
 * Walrus, then prints each blob id and the expiry the relayer reports. Run it close to the date by which the
 * memories must still be readable, so their storage lease covers that date.
 *
 *   pnpm tsx scripts/write-demo-memories.ts [--mock] [--valid-until 2026-12-31] [--project <name>]
 *
 * Live mode reads WALRUS_RELAYER_URL, WALRUS_ACCOUNT_ID, WALRUS_DELEGATE_KEY (see .env.example). The
 * date may also come from VALID_UNTIL. Nothing is faked: expiry values are whatever the storage layer returns.
 */
import { pathToFileURL } from 'node:url';
import { createDrain } from '../packages/api/src/index.js';
import { expiryScan } from '../packages/worker/src/index.js';
import { liveWorld, mockWorld } from './lib/world.js';

type Spec = { type: string; text: string };

export const DEMO_MEMORIES: Spec[] = [
  { type: 'constraint', text: 'Never import from internal/ in app code; use the public barrel files.' },
  {
    type: 'constraint',
    text: 'All database access goes through the repository layer; no raw SQL in handlers.',
  },
  { type: 'preference', text: 'Name integration tests *.int.test.ts so the fast suite can exclude them.' },
  {
    type: 'preference',
    text: 'Errors crossing a module boundary are wrapped in AppError with a stable code.',
  },
  {
    type: 'decision',
    text: 'Chose cursor pagination over offset pagination for list endpoints to keep results stable.',
  },
  { type: 'decision', text: 'Background jobs use the Postgres queue rather than a separate broker.' },
  {
    type: 'failure',
    text: 'Running the users migration in one transaction exceeded the gas limit; use batches of 200 rows.',
  },
  {
    type: 'failure',
    text: 'The e2e suite is flaky when run in parallel against one database; run it serially.',
  },
  { type: 'fact', text: 'The staging database is reset every night; do not keep fixtures there.' },
  { type: 'fact', text: 'The public API is versioned in the URL path; v1 is frozen.' },
  { type: 'procedure', text: 'Run the full check with: pnpm typecheck && pnpm lint && pnpm test.' },
  {
    type: 'procedure',
    text: 'Apply migrations locally with: pnpm db:migrate; roll back one step with: pnpm db:rollback.',
  },
];

export interface WriteOptions {
  mock?: boolean;
  validUntil?: string;
  projectName?: string;
  env?: Record<string, string | undefined>;
  log?: (s: string) => void;
}

export interface WrittenMemory {
  memoryId: string;
  type: string;
  blobId: string | null;
  expiresAt: string | null;
}

export async function writeDemoMemories(
  o: WriteOptions = {},
): Promise<{ memories: WrittenMemory[]; warnings: string[] }> {
  const log = o.log ?? (() => {});
  const env = o.env ?? process.env;
  const world = o.mock ? await mockWorld() : await liveWorld(env);
  const { stack, clock } = world;
  const warnings: string[] = [];
  try {
    const ws = await stack.newWorkspace('Demo');
    const prj = await stack.newProject(ws.id, o.projectName ?? 'orbit-api', { networks: ['sui:mainnet'] });
    // Each agent has a per-minute write budget; spread the seed across a few agents instead of bypassing it.
    const perAgent = 5;
    const backends = [];
    for (let i = 0; i < Math.ceil(DEMO_MEMORIES.length / perAgent); i++) {
      const agent = await stack.newAgent({
        workspaceId: ws.id,
        projectId: prj.id,
        name: `seed-${i + 1}`,
        tool: 'claude-code',
      });
      const be = await stack.backendFor(agent.token);
      await be.connect({ project: prj.id, client: 'claude-code' });
      backends.push(be);
    }
    const backend = backends[0]!;
    const ids: { id: string; type: string }[] = [];
    for (const [n, m] of DEMO_MEMORIES.entries()) {
      const r = await backends[Math.floor(n / perAgent)]!.remember({
        text: m.text,
        type: m.type as never,
        idempotencyKey: `client:seed:${m.text.length}:${ids.length}`,
      });
      ids.push({ id: r.memoryId, type: m.type });
      log(`queued ${r.memoryId} (${m.type})`);
    }
    const drain = createDrain(stack.deps, world.adapter, { pollIntervalMs: 500 });
    for (let i = 0; i < 400; i++) {
      await drain.tick();
      const q = await stack.db.system((tx) =>
        tx.query<{ n: string }>(`select count(*) as n from write_jobs where state not in ('stored','dead')`),
      );
      if (Number(q.rows[0]!.n) === 0) break;
      if (o.mock) clock.advance(3000);
      else await new Promise((r) => setTimeout(r, 1500));
    }
    await expiryScan(stack.deps, { adapter: world.adapter, checkIntervalMs: 6 * 3_600_000 });
    const memories: WrittenMemory[] = [];
    for (const { id, type } of ids) {
      const d = await backend.getMemory(id);
      memories.push({ memoryId: id, type, blobId: d.walrusBlobId ?? null, expiresAt: d.expiresAt ?? null });
      if (d.writeState !== 'stored') warnings.push(`${id} is not stored yet (state: ${d.writeState})`);
    }
    const until = o.validUntil ?? env.VALID_UNTIL;
    if (until) {
      const t = Date.parse(until);
      if (Number.isNaN(t)) warnings.push(`could not parse --valid-until "${until}"`);
      else
        for (const m of memories)
          if (m.expiresAt && Date.parse(m.expiresAt) < t)
            warnings.push(
              `${m.memoryId} expires ${m.expiresAt}, before ${until}; renew storage or re-run later`,
            );
    }
    return { memories, warnings };
  } finally {
    await world.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const validUntil = flag('--valid-until');
  const projectName = flag('--project');
  const r = await writeDemoMemories({
    mock: argv.includes('--mock'),
    ...(validUntil ? { validUntil } : {}),
    ...(projectName ? { projectName } : {}),
    log: (s) => console.log(s),
  });
  console.log('\nblob id                    expires                    type        memory');
  for (const m of r.memories)
    console.log(
      `${(m.blobId ?? '-').padEnd(26)} ${(m.expiresAt ?? 'unknown').padEnd(26)} ${m.type.padEnd(11)} ${m.memoryId}`,
    );
  for (const w of r.warnings) console.error(`WARNING: ${w}`);
  process.exit(r.warnings.length ? 2 : 0);
}
