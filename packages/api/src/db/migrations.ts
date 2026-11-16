import { WRITE_JOBS_DDL, type SqlClient } from '@buiry/storage';

export interface Migration {
  id: string;
  sql: string;
}

/** Tables that carry workspace_id and are protected by row-level security. */
export const TENANT_TABLES = [
  'memberships',
  'invitations',
  'projects',
  'branches',
  'agents',
  'agent_tokens',
  'memories',
  'memory_events',
  'evidence',
  'verifications',
  'flags',
  'handoffs',
  'activity_log',
  'webhooks',
  'webhook_deliveries',
  'alert_rules',
  'packs',
  'tatum_calls',
  'branch_merges',
  'usage_meters',
  'subscriptions',
] as const;

const INIT = `
create table users (
  id text primary key,
  email text unique,
  display_name text,
  created_at timestamptz not null default now()
);
create table identities (
  id text primary key,
  user_id text not null references users(id),
  provider text not null check (provider in ('wallet','google','github','email')),
  subject text not null,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);
create table sessions (
  id text primary key,
  user_id text not null references users(id),
  token_hash text not null unique,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create table auth_challenges (
  nonce text primary key,
  purpose text not null,
  subject text,
  domain text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table workspaces (
  id text primary key,
  name text not null,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);
create table memberships (
  workspace_id text not null references workspaces(id),
  user_id text not null references users(id),
  role text not null check (role in ('owner','admin','writer','reader')),
  project_scope text[],
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create table invitations (
  id text primary key,
  workspace_id text not null references workspaces(id),
  invitee text not null,
  role text not null check (role in ('admin','writer','reader')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create table projects (
  id text primary key,
  workspace_id text not null references workspaces(id),
  name text not null,
  description text,
  networks text[] not null default '{}',
  walrus_mode text not null default 'managed' check (walrus_mode in ('managed','byo','self_hosted')),
  walrus_account_id text,
  relayer_url text not null default '',
  repo_fingerprint text,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create table branches (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  slug text not null,
  namespace text not null unique,
  protected boolean not null default false,
  parent_branch_id text,
  created_by text,
  created_at timestamptz not null default now(),
  merged_at timestamptz,
  archived_at timestamptz,
  unique (project_id, slug)
);
create table agents (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  slug text not null,
  name text not null,
  tool text not null,
  client_version text,
  permissions text[] not null default '{read,write}',
  branch_scope text,
  active_branch text not null default 'main',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  first_connected_at timestamptz,
  last_seen_at timestamptz,
  first_check_at timestamptz,
  last_check_at timestamptz,
  unique (project_id, slug)
);
create table agent_tokens (
  id text primary key,
  workspace_id text not null references workspaces(id),
  agent_id text not null references agents(id),
  token_hash text not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create table memories (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  branch_id text not null references branches(id),
  branch_slug text not null,
  type text not null check (type in ('decision','constraint','fact','failure','procedure','preference','task_state','deployment','handoff')),
  status text not null check (status in ('proposed','confirmed','contested','stale','superseded','tombstoned')),
  text text not null,
  confidence real not null,
  agent_slug text not null,
  agent_id text,
  actor_kind text not null default 'agent',
  session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_reinforced_at timestamptz not null default now(),
  supersedes_id text,
  superseded_by_id text,
  ref_memory_id text,
  walrus_blob_id text,
  walrus_job_id text,
  write_state text not null default 'queued' check (write_state in ('queued','stored','failed')),
  end_epoch int,
  expires_at timestamptz,
  expired boolean not null default false,
  flags text[] not null default '{}',
  learning jsonb not null default '{}',
  idempotency_key text not null,
  seq int not null default 0,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  unique (project_id, idempotency_key)
);
create index memories_listing_idx on memories (project_id, branch_slug, status, type);
create index memories_conf_idx on memories (project_id, confidence);
create index memories_expiry_idx on memories (project_id, expires_at);
create index memories_tsv_idx on memories using gin (tsv);
create table memory_events (
  id text primary key,
  workspace_id text not null references workspaces(id),
  memory_id text not null,
  project_id text not null references projects(id),
  tier text not null check (tier in ('A','B')),
  type text not null,
  payload jsonb not null default '{}',
  actor_kind text not null,
  actor_id text,
  seq int not null default 0,
  walrus_blob_id text,
  created_at timestamptz not null default now()
);
create index memory_events_memory_idx on memory_events (memory_id, created_at);
create index memory_events_project_idx on memory_events (project_id, created_at);
create table evidence (
  id text primary key,
  workspace_id text not null references workspaces(id),
  memory_id text not null,
  kind text not null check (kind in ('tx','object','package','file','url','test')),
  ref jsonb not null,
  network text,
  last_verified_at timestamptz,
  last_result text,
  last_detail jsonb
);
create index evidence_memory_idx on evidence (memory_id);
create table verifications (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  memory_id text,
  evidence_id text,
  kind text not null,
  result text not null check (result in ('pass','fail','unknown')),
  detail text,
  observed jsonb,
  transport text,
  node text,
  latency_ms int,
  credit_estimate int,
  degraded boolean not null default false,
  created_at timestamptz not null default now()
);
create table flags (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  memory_id text,
  kind text not null check (kind in ('stale','contested','expiring','failed_write','possible_conflict','needs_review','injection','relayer','verification')),
  severity text not null check (severity in ('critical','warning','info')),
  state text not null default 'open' check (state in ('open','acknowledged','resolved')),
  detail text not null,
  group_key text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  acknowledged_by text,
  resolved_at timestamptz
);
create index flags_open_idx on flags (project_id, state, severity);
create table handoffs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  branch_slug text not null,
  memory_id text not null,
  agent_slug text not null,
  done jsonb not null default '[]',
  blocked jsonb not null default '[]',
  next jsonb not null default '[]',
  relied_on text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now()
);
create table activity_log (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text,
  actor_kind text not null,
  actor_id text,
  operation text not null,
  target jsonb not null default '{}',
  result text not null,
  latency_ms int,
  request_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index activity_project_idx on activity_log (project_id, created_at desc);
create table webhooks (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text,
  name text not null,
  kind text not null check (kind in ('slack','discord','generic')),
  url text not null,
  secret text not null,
  events text[] not null default '{}',
  status text not null default 'active' check (status in ('active','paused')),
  paused_reason text,
  created_at timestamptz not null default now()
);
create table webhook_deliveries (
  id text primary key,
  workspace_id text not null references workspaces(id),
  webhook_id text not null references webhooks(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  state text not null default 'pending' check (state in ('pending','delivered','failed')),
  attempts int not null default 0,
  status_code int,
  duration_ms int,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table alert_rules (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  event text not null,
  min_severity text not null default 'warning',
  channel text not null default 'dashboard',
  webhook_id text,
  quiet_hours jsonb,
  grouping boolean not null default true,
  enabled boolean not null default true
);
create table packs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  direction text not null check (direction in ('export','import')),
  actor text,
  counts jsonb not null default '{}',
  manifest jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table tatum_calls (
  id text primary key,
  workspace_id text,
  method text not null,
  transport text not null,
  network text,
  latency_ms int not null,
  status text not null,
  error_kind text,
  credit_estimate int not null default 0,
  created_at timestamptz not null default now()
);
create table relayer_status (
  id text primary key,
  relayer_url text not null,
  reachable boolean not null,
  write_state text not null,
  version text,
  checked_at timestamptz not null default now()
);
create table branch_merges (
  id text primary key,
  workspace_id text not null references workspaces(id),
  project_id text not null references projects(id),
  source_branch_id text not null,
  target_branch_id text not null,
  merged_by text,
  summary jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table plans (
  id text primary key,
  name text not null,
  limits jsonb not null default '{}'
);
create table subscriptions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  plan_id text not null references plans(id),
  status text not null default 'active',
  renews_at timestamptz,
  created_at timestamptz not null default now()
);
create table usage_meters (
  id text primary key,
  workspace_id text not null references workspaces(id),
  period text not null,
  meter text not null,
  value bigint not null default 0,
  unique (workspace_id, period, meter)
);
create table audit_log (
  id text primary key,
  workspace_id text,
  actor text,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger activity_log_append_only before update or delete on activity_log for each row execute function forbid_mutation();
create trigger audit_log_append_only before update or delete on audit_log for each row execute function forbid_mutation();
`;

const rls = (): string => {
  const parts: string[] = [
    `do $$ begin if not exists (select 1 from pg_roles where rolname = 'buiry_app') then create role buiry_app nologin; end if; end $$;`,
    `grant usage on schema public to buiry_app;`,
    `grant select, insert, update, delete on all tables in schema public to buiry_app;`,
    `revoke update, delete on activity_log, audit_log from buiry_app;`,
    `revoke all on auth_challenges, sessions, users, identities, plans from buiry_app;`,
  ];
  for (const t of TENANT_TABLES) {
    parts.push(
      `alter table ${t} enable row level security;`,
      `alter table ${t} force row level security;`,
      `create policy tenant_isolation on ${t} using (workspace_id = current_setting('app.workspace_id', true)) with check (workspace_id = current_setting('app.workspace_id', true));`,
    );
  }
  // The write queue has no workspace column: a job is visible to a tenant only through a project it owns.
  parts.push(
    `alter table write_jobs enable row level security;`,
    `create policy tenant_isolation on write_jobs using (project_id in (select id from projects)) with check (project_id in (select id from projects));`,
  );
  // Workspaces are visible only to their own tenant context.
  parts.push(
    `alter table workspaces enable row level security;`,
    `alter table workspaces force row level security;`,
    `create policy tenant_isolation on workspaces using (id = current_setting('app.workspace_id', true)) with check (id = current_setting('app.workspace_id', true));`,
  );
  return parts.join('\n');
};

const API_TOKENS = `
create table api_tokens (
  id text primary key,
  workspace_id text not null references workspaces(id),
  name text not null,
  token_hash text not null unique,
  prefix text not null,
  scopes text[] not null default '{read}',
  project_ids text[],
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create table job_leases (
  name text primary key,
  holder text not null,
  leased_until timestamptz not null,
  last_run_at timestamptz
);
create table magic_links (
  token_hash text primary key,
  email text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table memories add column snapshot_at timestamptz;
alter table memories add column snapshot_confidence real;
grant select, insert, update, delete on api_tokens to buiry_app;
alter table api_tokens enable row level security;
alter table api_tokens force row level security;
create policy tenant_isolation on api_tokens using (workspace_id = current_setting('app.workspace_id', true)) with check (workspace_id = current_setting('app.workspace_id', true));
`;

const ACTIVITY_SEQ = `
alter table activity_log add column n bigserial;
create index activity_n_idx on activity_log (project_id, n);
grant usage, select on sequence activity_log_n_seq to buiry_app;
`;

// Bring-your-own Walrus Memory account per project. The delegate key is sealed (AES-256-GCM, key derived from
// BUIRY_SECRET_KEY); only its public half is ever returned. managed_tenant records the one workspace allowed to use
// the deployment's managed account (single row, no tenant data, so no row-level policy).
const PROJECT_STORAGE = `
create table project_storage (
  project_id text primary key references projects(id) on delete cascade,
  workspace_id text not null references workspaces(id),
  relayer_url text not null,
  network text not null check (network in ('mainnet','testnet')),
  account_id text not null,
  delegate_key_sealed text not null,
  delegate_public_key text not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on project_storage to buiry_app;
alter table project_storage enable row level security;
alter table project_storage force row level security;
create policy tenant_isolation on project_storage using (workspace_id = current_setting('app.workspace_id', true)) with check (workspace_id = current_setting('app.workspace_id', true));
create table managed_tenant (
  id integer primary key check (id = 1),
  workspace_id text not null references workspaces(id),
  claimed_at timestamptz not null default now()
);
grant select, insert on managed_tenant to buiry_app;
`;

export const MIGRATIONS: Migration[] = [
  { id: '001_init', sql: INIT },
  { id: '002_write_jobs', sql: WRITE_JOBS_DDL },
  { id: '003_rls', sql: rls() },
  { id: '004_api_tokens_leases', sql: API_TOKENS },
  { id: '005_activity_seq', sql: ACTIVITY_SEQ },
  { id: '006_project_storage', sql: PROJECT_STORAGE },
];

export async function migrate(
  db: SqlClient & { exec?: (sql: string) => Promise<unknown> },
): Promise<string[]> {
  await db.query(
    `create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`,
  );
  const done = new Set(
    (await db.query<{ id: string }>('select id from schema_migrations')).rows.map((r) => r.id),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    if (db.exec) await db.exec(m.sql);
    else await db.query(m.sql);
    await db.query('insert into schema_migrations (id) values ($1)', [m.id]);
    applied.push(m.id);
  }
  return applied;
}
