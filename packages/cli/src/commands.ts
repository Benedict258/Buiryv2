// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BuiryError,
  MEMORY_TYPES,
  generateBuiryMd,
  updateSnapshot,
  type Evidence,
  type MemoryType,
} from '@buiry/core';
import { RestBackend } from '@buiry/mcp';
import { ApiClient, anonymous, type Credentials } from './api.js';
import { str, type Parsed } from './args.js';
import {
  buiryMdPath,
  loadCredentials,
  readProjectFile,
  readState,
  saveCredentials,
  writeState,
  type Runtime,
} from './config.js';
import {
  COMPETING,
  TOOLS,
  mcpServerNames,
  patchPointer,
  pointerFileFor,
  readBuiryServerEnv,
  serverSpec,
  launchFromEnv,
  targetFor,
  writeToolConfig,
  type Tool,
} from './tools.js';

export class UsageError extends Error {}

type Cmd = (a: Parsed, rt: Runtime) => Promise<number>;

const out = (rt: Runtime, s = '') => rt.stdout(s + '\n');
const asJson = (a: Parsed) => a.flags.json === true;

function creds(rt: Runtime): Credentials {
  const c = loadCredentials(rt);
  if (!c) throw new BuiryError('unauthorized', 'not signed in: run `buiry login`');
  return c;
}
const client = (rt: Runtime) => new ApiClient(creds(rt), rt.fetch);

function project(rt: Runtime): { projectId: string; networks: string[]; source: string } {
  const p = readProjectFile(rt.cwd);
  if (!p) throw new BuiryError('not_found', 'no BUIRY.md here: run `buiry init` in your repository');
  return p;
}

const fingerprint = async (rt: Runtime): Promise<string | undefined> => {
  const r = await rt.exec('git', ['config', '--get', 'remote.origin.url'], rt.cwd);
  const url = r.stdout.trim();
  return r.code === 0 && url
    ? createHash('sha256')
        .update(url.replace(/\.git$/, '').toLowerCase())
        .digest('hex')
        .slice(0, 32)
    : undefined;
};

// ---------- login ----------

const login: Cmd = async (a, rt) => {
  const apiUrl = str(a.flags, 'api') ?? rt.env.BUIRY_API_URL ?? loadCredentials(rt)?.apiUrl;
  if (!apiUrl) throw new UsageError('pass --api <url> (your Buiry server) the first time');
  let token = str(a.flags, 'token');
  const email = str(a.flags, 'email');
  if (!token && email) {
    await anonymous(apiUrl, '/v1/auth/email/start', { email }, rt.fetch);
    out(rt, `We sent a sign-in link to ${email}.`);
    const pasted = (await rt.prompt('Paste the link (or just its token): ')).trim();
    const t = pasted.includes('token=') ? new URL(pasted).searchParams.get('token')! : pasted;
    const v = await anonymous(apiUrl, '/v1/auth/email/verify', { token: t }, rt.fetch);
    token = v.session.token as string;
  }
  if (!token) throw new UsageError('pass --token <api token or session> or --email <address>');
  const who = await new ApiClient({ apiUrl, token }, rt.fetch).get('/v1/auth/whoami');
  saveCredentials(rt, { apiUrl, token });
  if (asJson(a)) out(rt, JSON.stringify(who));
  else out(rt, `Signed in (${who.type}) to ${apiUrl}. ${who.workspaces.length} workspace(s).`);
  return 0;
};

// ---------- init ----------

const init: Cmd = async (a, rt) => {
  const api = client(rt);
  const existing = readProjectFile(rt.cwd);
  const link = str(a.flags, 'link');
  if (existing && !link) {
    await api.get(`/v1/projects/${existing.projectId}`); // proves access
    out(rt, `Already linked: ${existing.projectId} (BUIRY.md found). Nothing changed.`);
    return 0;
  }
  let projectId = link;
  let networks = (str(a.flags, 'network') ?? '').split(',').filter(Boolean);
  if (!projectId) {
    const who = await api.get('/v1/auth/whoami');
    const ws = str(a.flags, 'workspace') ?? who.workspaces[0]?.id;
    if (!ws) throw new BuiryError('not_found', 'no workspace available for this credential');
    const name = str(a.flags, 'name') ?? rt.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
    const fp = await fingerprint(rt);
    const created = await api.post(`/v1/workspaces/${ws}/projects`, {
      name,
      networks,
      ...(fp ? { repoFingerprint: fp } : {}),
    });
    projectId = created.id as string;
    out(rt, `Created project ${name} (${projectId}).`);
  }
  const t = await api.get(`/v1/projects/${projectId}/buirymd`);
  networks = t.networks.length ? t.networks : networks;
  writeFileSync(
    buiryMdPath(rt.cwd),
    generateBuiryMd({ projectId, networks, ...(t.snapshot ? { snapshot: t.snapshot.text } : {}) }),
  );
  out(rt, 'Wrote BUIRY.md. It contains no secrets: commit it so every tool and teammate finds this project.');
  out(rt, 'Next: `buiry connect claude-code` (or opencode, cursor, codex).');
  return 0;
};

// ---------- connect ----------

const connect: Cmd = async (a, rt) => {
  const tool = a.positionals[0] as Tool | undefined;
  if (!tool || !(TOOLS as readonly string[]).includes(tool))
    throw new UsageError(
      `usage: buiry connect <${TOOLS.join('|')}> [--name n] [--permissions read,write] [--branch b] [--print]`,
    );
  const p = project(rt);
  const c = creds(rt);
  const api = new ApiClient(c, rt.fetch);
  const perms = (str(a.flags, 'permissions') ?? 'read,write').split(',').filter(Boolean);
  const made = await api.post(`/v1/projects/${p.projectId}/agents`, {
    name: str(a.flags, 'name') ?? tool,
    tool,
    permissions: perms,
    ...(str(a.flags, 'branch') ? { branchScope: str(a.flags, 'branch') } : {}),
  });
  const spec = serverSpec(made.token as string, c.apiUrl, launchFromEnv(rt.env.BUIRY_MCP_COMMAND));
  const target = targetFor(tool, rt.home);
  out(rt, `Issued a token for agent ${made.slug} (shown once; stored only in the tool config below).`);
  if (a.flags.print === true || target.format === 'none') {
    out(rt, `Add this MCP server to ${tool}:\n`);
    out(rt, target.snippet(spec));
  } else {
    try {
      const w = writeToolConfig(target, spec);
      out(rt, `Updated ${target.path}${w.backup ? ` (original saved as ${w.backup})` : ''}.`);
    } catch (e) {
      out(rt, `Could not update ${target.path}: ${(e as Error).message}. Add this yourself:\n`);
      out(rt, target.snippet(spec));
    }
  }
  if (a.flags['no-pointer'] !== true) {
    const ptr = pointerFileFor(tool, rt.cwd);
    if (ptr)
      out(rt, `${patchPointer(ptr.path, ptr.frontMatter)} ${ptr.path} (a pointer to BUIRY.md, no secrets).`);
  }
  // Test the connection exactly as the tool will make it.
  const backend = new RestBackend({ baseUrl: c.apiUrl, token: made.token, fetch: rt.fetch });
  const checks: [string, () => Promise<string>][] = [
    [
      'token valid, project found',
      async () => `${(await backend.connect({ project: p.projectId, client: 'buiry-cli' })).project.name}`,
    ],
    [
      'storage and verification',
      async () => {
        const s = await backend.status();
        return `relayer ${s.relayer.state}, gateway ${s.gateway.state}`;
      },
    ],
  ];
  let ok = true;
  for (const [label, run] of checks) {
    try {
      out(rt, `  ok   ${label}: ${await run()}`);
    } catch (e) {
      ok = false;
      out(rt, `  FAIL ${label}: ${(e as Error).message}`);
    }
  }
  out(
    rt,
    ok
      ? `Restart ${tool} so it loads the Buiry MCP server.`
      : 'The connection test failed; run `buiry doctor`.',
  );
  return ok ? 0 : 1;
};

// ---------- status / doctor ----------

const status: Cmd = async (a, rt) => {
  const api = client(rt);
  const p = project(rt);
  const [st, ov] = await Promise.all([
    api.get(`/v1/projects/${p.projectId}/status`),
    api.get(`/v1/projects/${p.projectId}/overview`),
  ]);
  if (asJson(a)) {
    out(rt, JSON.stringify({ status: st, overview: ov }, null, 2));
    return 0;
  }
  const by: Record<string, number> = {};
  for (const r of ov.byTypeAndStatus) by[r.status] = (by[r.status] ?? 0) + r.count;
  out(
    rt,
    `Project   ${ov.project.name} (${p.projectId})  networks: ${ov.project.networks.join(', ') || 'none'}`,
  );
  out(
    rt,
    `Memories  ${st.project.memories}  ${Object.entries(by)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}`,
  );
  out(
    rt,
    `Queue     queued ${st.queue.queued}, in flight ${st.queue.submitting + st.queue.submitted}, stored ${st.queue.stored}, failed ${st.queue.dead}`,
  );
  out(rt, `Relayer   ${st.relayer.state}${st.relayer.version ? ` (${st.relayer.version})` : ''}`);
  out(rt, `Gateway   ${st.gateway.state}`);
  out(
    rt,
    `Expiry    ${st.expiry.expiring} expiring, ${st.expiry.expired} lapsed${st.expiry.soonest ? `, soonest ${st.expiry.soonest.slice(0, 10)}` : ''}`,
  );
  const flags = ov.openFlags.reduce((n: number, f: { count: number }) => n + f.count, 0);
  out(rt, `Flags     ${flags} open`);
  out(
    rt,
    `Agents    ${ov.agents.map((g: { slug: string; activeLast24h: boolean; revoked: boolean }) => `${g.slug}${g.revoked ? ' (revoked)' : g.activeLast24h ? ' (active)' : ''}`).join(', ') || 'none'}`,
  );
  return 0;
};

const doctor: Cmd = async (a, rt) => {
  let failures = 0;
  const line = (kind: 'ok' | 'warn' | 'FAIL', msg: string) => {
    if (kind === 'FAIL') failures++;
    out(rt, `${kind.padEnd(4)}  ${msg}`);
  };
  const c = loadCredentials(rt);
  if (!c) {
    line('FAIL', 'not signed in. Run `buiry login --api <url> --email <you>`');
    return 1;
  }
  line('ok', `credentials found for ${c.apiUrl}`);
  const api = new ApiClient(c, rt.fetch);
  try {
    await api.get('/v1/healthz');
    line('ok', 'API reachable');
  } catch (e) {
    line('FAIL', `API unreachable: ${(e as Error).message}`);
    return 1;
  }
  try {
    await api.get('/v1/auth/whoami');
    line('ok', 'credential accepted');
  } catch (e) {
    line('FAIL', `credential rejected: ${(e as Error).message}`);
  }
  const p = readProjectFile(rt.cwd);
  if (!p) line('FAIL', 'no BUIRY.md in this directory (run `buiry init`)');
  else {
    line('ok', `BUIRY.md found (project ${p.projectId})`);
    try {
      const st = await api.get(`/v1/projects/${p.projectId}/status`);
      line('ok', 'project accessible');
      line(
        st.relayer.state === 'ok' ? 'ok' : st.relayer.state === 'unknown' ? 'warn' : 'FAIL',
        `storage relayer: ${st.relayer.state}`,
      );
      line(
        st.gateway.state === 'ok' ? 'ok' : 'warn',
        st.gateway.state === 'unconfigured'
          ? 'chain gateway: unconfigured (chain verification disabled)'
          : st.gateway.state === 'ok'
            ? 'chain gateway: ok (chain checks run over gRPC only)'
            : `chain gateway: ${st.gateway.state}. Chain checks run over gRPC only; while it is down, evidence is reported unknown, never a stale pass`,
      );
      if (st.queue.dead > 0)
        line('FAIL', `${st.queue.dead} writes failed after retries (see Storage health)`);
      if (st.expiry.expiring > 0) line('warn', `${st.expiry.expiring} memories are approaching expiry`);
    } catch (e) {
      line('FAIL', `project not accessible: ${(e as Error).message}`);
    }
  }
  // Tool configs: is Buiry installed and does its token work? Is another memory tool competing?
  const seen = new Set<string>();
  for (const tool of TOOLS.filter((t) => t !== 'generic')) {
    const t = targetFor(tool, rt.home);
    if (t.format === 'none') continue;
    const names = mcpServerNames(t.path, t.format);
    if (names.includes('buiry')) {
      const env = readBuiryServerEnv(t.path, t.format);
      if (env?.token && env.apiUrl) {
        try {
          await new RestBackend({ baseUrl: env.apiUrl, token: env.token, fetch: rt.fetch }).status();
          line('ok', `${tool}: Buiry MCP configured, token valid`);
        } catch (e) {
          line('FAIL', `${tool}: Buiry MCP configured but the token fails: ${(e as Error).message}`);
        }
      } else line('warn', `${tool}: Buiry MCP configured, token not readable here`);
    }
    for (const n of names.filter((n) => n !== 'buiry' && COMPETING.test(n))) seen.add(`${tool}: ${n}`);
  }
  for (const f of [join(rt.cwd, '.mcp.json')])
    for (const n of mcpServerNames(f, 'json').filter((n) => n !== 'buiry' && COMPETING.test(n)))
      seen.add(`project .mcp.json: ${n}`);
  for (const s of seen)
    line(
      'warn',
      `another memory tool is configured (${s}); two memory tools can compete for the agent's attention. Buiry's tools are prefixed buiry_*; BUIRY.md says to use them for project knowledge.`,
    );
  out(rt, failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
  void a;
  return failures ? 1 : 0;
};

// ---------- briefing / remember / recall ----------

const branchOf = (a: Parsed, rt: Runtime) => str(a.flags, 'branch') ?? readState(rt.cwd).branch;

const briefing: Cmd = async (a, rt) => {
  const p = project(rt);
  const q = new URLSearchParams();
  if (str(a.flags, 'task')) q.set('task', str(a.flags, 'task')!);
  if (str(a.flags, 'budget')) q.set('budget', str(a.flags, 'budget')!);
  if (branchOf(a, rt)) q.set('branch', branchOf(a, rt)!);
  if (a.flags.onboarding === true) q.set('onboarding', 'true');
  const r = await client(rt).get(`/v1/projects/${p.projectId}/briefing?${q}`);
  out(rt, asJson(a) ? JSON.stringify(r, null, 2) : r.briefing.trimEnd());
  if (!asJson(a)) out(rt, `\n(${r.tokensUsed} tokens${r.onboarding ? ', onboarding' : ''})`);
  return 0;
};

/** Evidence flag syntax: tx=<digest>,obj=<id>@<ver>,pkg=<id>,file=<path>@<commit>,url=<href>,test=<name>:<pass|fail>; network via --network. */
export function parseEvidence(spec: string | undefined, network: string): Evidence[] {
  if (!spec) return [];
  return spec
    .split(',')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      const k = part.slice(0, i);
      const v = part.slice(i + 1);
      if (i < 1 || !v) throw new UsageError(`bad evidence "${part}" (use kind=value)`);
      switch (k) {
        case 'tx':
          return { kind: 'tx', digest: v, network };
        case 'obj': {
          const [id, ver] = v.split('@');
          return { kind: 'object', id: id!, ...(ver ? { version: ver } : {}), network };
        }
        case 'pkg':
          return { kind: 'package', id: v, network };
        case 'file': {
          const [path, commit] = v.split('@');
          return { kind: 'file', path: path!, ...(commit ? { commit } : {}) };
        }
        case 'url':
          return { kind: 'url', href: v };
        case 'test': {
          const j = v.lastIndexOf(':');
          const res = v.slice(j + 1);
          if (j < 1 || (res !== 'pass' && res !== 'fail'))
            throw new UsageError('test evidence is test=<name>:<pass|fail>');
          return { kind: 'test', name: v.slice(0, j), result: res };
        }
        default:
          throw new UsageError(`unknown evidence kind "${k}"`);
      }
    });
}

const remember: Cmd = async (a, rt) => {
  const text = a.positionals.join(' ').trim();
  const type = str(a.flags, 'type') as MemoryType | undefined;
  if (!text || !type || !(MEMORY_TYPES as readonly string[]).includes(type))
    throw new UsageError(
      `usage: buiry remember "<text>" --type <${MEMORY_TYPES.join('|')}> [--evidence tx=...,file=path@sha] [--branch b] [--confirm]`,
    );
  const p = project(rt);
  const network = str(a.flags, 'network') ?? p.networks.find((n) => n.startsWith('sui:')) ?? 'sui:mainnet';
  const r = await client(rt).post(`/v1/projects/${p.projectId}/memories`, {
    text,
    type,
    evidence: parseEvidence(str(a.flags, 'evidence'), network),
    ...(branchOf(a, rt) ? { branch: branchOf(a, rt) } : {}),
    status: a.flags.confirm === true ? 'confirmed' : 'proposed',
  });
  if (asJson(a)) out(rt, JSON.stringify(r));
  else {
    out(rt, `Recorded ${r.memoryId} as ${r.status} (${r.state}).`);
    if (r.redaction.applied) out(rt, `Redacted: ${r.redaction.kinds.join(', ')}`);
    for (const c of r.conflictCandidates)
      out(rt, `Possible conflict with ${c.memoryId} (${Math.round(c.similarity * 100)}%): ${c.text}`);
  }
  return 0;
};

const recall: Cmd = async (a, rt) => {
  const query = a.positionals.join(' ').trim();
  if (!query) throw new UsageError('usage: buiry recall "<query>" [--type t] [--limit n]');
  const p = project(rt);
  const q = new URLSearchParams({ q: query, limit: str(a.flags, 'limit') ?? '10' });
  if (str(a.flags, 'type')) q.set('type', str(a.flags, 'type')!);
  if (branchOf(a, rt)) q.set('branch', branchOf(a, rt)!);
  const r = await client(rt).get(`/v1/projects/${p.projectId}/memories?${q}`);
  if (asJson(a)) out(rt, JSON.stringify(r.items, null, 2));
  else if (!r.items.length) out(rt, 'No matching memories.');
  else
    for (const m of r.items)
      out(
        rt,
        `[${m.status} | ${m.effectiveConfidence.toFixed(2)}] ${m.id} (${m.type}, ${m.branch}): ${m.text}`,
      );
  return 0;
};

// ---------- verify (repository evidence) ----------

const verify: Cmd = async (a, rt) => {
  const p = project(rt);
  const api = client(rt);
  const files = new Map<string, string | undefined>();
  let cursor: string | null = null;
  do {
    const page: { items: { evidence: Evidence[] }[]; nextCursor: string | null } = await api.get(
      `/v1/projects/${p.projectId}/memories?evidence=any&limit=200${cursor ? `&cursor=${cursor}` : ''}`,
    );
    for (const m of page.items)
      for (const e of m.evidence) if (e.kind === 'file') files.set(e.path, e.commit);
    cursor = page.nextCursor;
  } while (cursor);
  const results: Record<string, { exists: boolean; changed: boolean; currentCommit?: string }> = {};
  for (const [path, commit] of files) {
    const full = join(rt.cwd, path);
    if (!existsSync(full)) {
      results[path] = { exists: false, changed: true };
      continue;
    }
    let changed = false;
    if (commit) {
      const d = await rt.exec('git', ['diff', '--quiet', commit, '--', path], rt.cwd);
      if (d.code === 1) changed = true;
      else if (d.code !== 0) continue; // unknown commit or not a git repository: send nothing rather than guess
    }
    const head = await rt.exec('git', ['log', '-1', '--format=%h', '--', path], rt.cwd);
    results[path] = {
      exists: true,
      changed,
      ...(head.code === 0 && head.stdout.trim() ? { currentCommit: head.stdout.trim() } : {}),
    };
  }
  if (!Object.keys(results).length) {
    out(rt, 'No file evidence to check.');
    return 0;
  }
  // Only results leave the machine: no file contents, no hashes of contents.
  const r = await api.post(`/v1/projects/${p.projectId}/verify-repo`, { results });
  if (asJson(a)) out(rt, JSON.stringify(r, null, 2));
  else {
    out(rt, `Checked ${r.checked} memories: ${r.unchanged} files unchanged, ${r.changed.length} changed.`);
    for (const c of r.changed) out(rt, `  review ${c.memoryId}: ${c.detail}`);
  }
  return r.changed.length ? 1 : 0;
};

// ---------- export / import ----------

const exportCmd: Cmd = async (a, rt) => {
  const p = project(rt);
  const types = str(a.flags, 'types')?.split(',').filter(Boolean);
  const pack = await client(rt).post(`/v1/projects/${p.projectId}/packs/export`, {
    ...(branchOf(a, rt) ? { branch: branchOf(a, rt) } : {}),
    ...(types ? { types } : {}),
    includeEvidence: a.flags['no-evidence'] !== true,
  });
  const file = str(a.flags, 'out') ?? join(rt.cwd, `buiry-pack-${p.projectId}.json`);
  writeFileSync(file, JSON.stringify(pack, null, 2));
  out(rt, `Exported ${pack.manifest.counts.total} memories to ${file}.`);
  return 0;
};

const importCmd: Cmd = async (a, rt) => {
  const file = a.positionals[0];
  if (!file) throw new UsageError('usage: buiry import <pack.json> [--branch b] [--yes]');
  const p = project(rt);
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  const api = client(rt);
  const pv = await api.post(`/v1/projects/${p.projectId}/packs/preview`, { pack });
  out(
    rt,
    `Pack: ${pv.counts.total} memories (${Object.entries(pv.counts.byType)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}).`,
  );
  for (const e of pv.errors) out(rt, `  error: ${e}`);
  const flagged = pv.items.filter(
    (i: { redaction: string[]; injection: string[]; blocked: boolean; duplicate: boolean }) =>
      i.redaction.length || i.injection.length || i.blocked || i.duplicate,
  );
  for (const i of flagged)
    out(
      rt,
      `  ${i.id}: ${[i.blocked ? 'BLOCKED (secret)' : '', i.redaction.length ? `redacted ${i.redaction.join(',')}` : '', i.injection.length ? `instruction-like text (${i.injection.join(',')})` : '', i.duplicate ? 'already imported' : ''].filter(Boolean).join('; ')}`,
    );
  if (!pv.valid) return 1;
  if (a.flags.yes !== true) {
    const ans = (await rt.prompt('Import as proposed memories? [y/N] ')).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      out(rt, 'Cancelled.');
      return 1;
    }
  }
  const r = await api.post(`/v1/projects/${p.projectId}/packs/import`, {
    pack,
    ...(branchOf(a, rt) ? { branch: branchOf(a, rt) } : {}),
  });
  out(
    rt,
    `Imported ${r.imported}, skipped ${r.skipped}. Imported memories arrive as proposed; review them in the dashboard.`,
  );
  return 0;
};

// ---------- branch / sync / evidence ----------

const branch: Cmd = async (a, rt) => {
  const p = project(rt);
  const api = client(rt);
  const [sub = 'list', name] = a.positionals;
  if (sub === 'list') {
    const r = await api.get(`/v1/projects/${p.projectId}/branches`);
    const cur = readState(rt.cwd).branch ?? 'main';
    for (const b of r.branches)
      out(
        rt,
        `${b.slug === cur ? '*' : ' '} ${b.slug}${b.protected ? ' (protected)' : ''}  ${b.memoryCount} memories`,
      );
    return 0;
  }
  if (!name) throw new UsageError(`usage: buiry branch ${sub} <name>`);
  if (sub === 'create') {
    await api.post(`/v1/projects/${p.projectId}/branches`, {
      name,
      ...(str(a.flags, 'from') ? { from: str(a.flags, 'from') } : {}),
    });
    out(rt, `Created branch ${name}.`);
    return 0;
  }
  if (sub === 'switch') {
    const r = await api.get(`/v1/projects/${p.projectId}/branches`);
    if (!r.branches.some((b: { slug: string }) => b.slug === name))
      throw new BuiryError('not_found', `no branch "${name}"`);
    writeState(rt.cwd, { branch: name });
    out(rt, `CLI commands now default to branch ${name}. (Agents choose their own branch via buiry_branch.)`);
    return 0;
  }
  if (sub === 'merge-proposal') {
    const r = await api.get(`/v1/projects/${p.projectId}/branches/${name}/merge-proposal`);
    out(rt, `${r.proposal.candidates.length} confirmed memories in ${name} not yet in ${r.proposal.target}.`);
    for (const c of r.proposal.candidates)
      out(
        rt,
        `  ${c.memoryId}${c.conflictWith.length ? `  CONFLICTS with ${c.conflictWith.map((x: { memoryId: string }) => x.memoryId).join(', ')}` : ''}: ${c.text}`,
      );
    out(rt, 'Merge from the dashboard (admin) to resolve conflicts.');
    return 0;
  }
  throw new UsageError('usage: buiry branch [list|create <name>|switch <name>|merge-proposal <name>]');
};

const sync: Cmd = async (_a, rt) => {
  const p = project(rt);
  const t = await client(rt).get(`/v1/projects/${p.projectId}/buirymd`);
  if (!t.snapshot) {
    out(rt, 'No snapshot generated yet (the worker creates one once memories exist).');
    return 0;
  }
  const next = updateSnapshot(p.source, t.snapshot.text);
  if (next === p.source) out(rt, 'BUIRY.md snapshot is already current.');
  else {
    writeFileSync(buiryMdPath(rt.cwd), next);
    out(
      rt,
      `Updated the snapshot region of BUIRY.md (generated ${t.snapshot.generatedAt}). Human-written sections were not touched.`,
    );
  }
  return 0;
};

const evidence: Cmd = async (a, rt) => {
  const p = project(rt);
  const r = await client(rt).get(`/v1/projects/${p.projectId}/evidence-report`);
  if (asJson(a)) {
    out(rt, JSON.stringify(r, null, 2));
    return 0;
  }
  out(rt, `Walrus Memory (${r.walrus.network ?? 'network unset'})`);
  out(rt, `  MemWalAccount ID     ${r.walrus.memWalAccountId ?? '(not set on the project)'}`);
  out(
    rt,
    `  Agent ID (delegate)  ${r.walrus.agentId_delegatePublicKey ?? '(WALRUS_DELEGATE_KEY not configured on the server)'}`,
  );
  out(rt, `  Relayer              ${r.walrus.relayerUrl ?? '(unset)'}`);
  out(
    rt,
    `  Stored memories      ${r.walrus.storedMemories}${r.walrus.soonestExpiry ? `   soonest expiry ${String(r.walrus.soonestExpiry).slice(0, 10)}` : ''}`,
  );
  for (const m of r.walrus.memories)
    out(
      rt,
      `    ${m.blobId}  ${m.type.padEnd(10)} ${m.status.padEnd(9)} expires ${m.expiresAt ? m.expiresAt.slice(0, 10) : 'unknown'}${m.endEpoch !== null ? ` (end epoch ${m.endEpoch})` : ''}`,
    );
  out(rt, `Tatum (${r.tatum.network ?? 'network unset'})`);
  out(
    rt,
    `  Calls ${r.tatum.calls} (gRPC ${r.tatum.grpcCalls}, JSON-RPC ${r.tatum.jsonrpcCalls})  avg ${r.tatum.avgLatencyMs} ms  p95 ${r.tatum.p95LatencyMs} ms  credits ~${r.tatum.creditsEstimated}`,
  );
  return 0;
};

export const COMMANDS: Record<string, { run: Cmd; summary: string }> = {
  login: { run: login, summary: 'Sign in (--api <url> with --token <t> or --email <you>)' },
  init: { run: init, summary: 'Create or link a project and write BUIRY.md' },
  connect: { run: connect, summary: 'Connect an agent: claude-code | opencode | cursor | codex | generic' },
  status: { run: status, summary: 'Queue, relayer, gateway and expiry summary' },
  doctor: {
    run: doctor,
    summary: 'Diagnose credentials, API, project file, tools and competing memory tools',
  },
  briefing: {
    run: briefing,
    summary: 'Print the briefing an agent would receive (--task, --budget, --onboarding)',
  },
  remember: { run: remember, summary: 'Write a memory: remember "<text>" --type decision [--evidence ...]' },
  recall: { run: recall, summary: 'Search memories: recall "<query>"' },
  verify: { run: verify, summary: 'Check repository evidence locally and send results only' },
  export: { run: exportCmd, summary: 'Export a memory pack to a file' },
  import: { run: importCmd, summary: 'Import a memory pack (previewed, redacted, imported as proposed)' },
  branch: { run: branch, summary: 'list | create <name> | switch <name> | merge-proposal <name>' },
  sync: { run: sync, summary: 'Refresh the BUIRY.md snapshot region from the server' },
  evidence: { run: evidence, summary: 'Show Walrus account, agent id, blob ids, expiry and Tatum usage' },
};
