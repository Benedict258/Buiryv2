import { BuiryError } from '@buiry/core';
import type { Tx } from '../db/db.js';

/** Entitlement dimensions. Values are placeholders until pricing is decided (PRD V10); null means unlimited. */
export const PLANS = {
  free: { projects: 3, agents: 5, memories: 1000, seats: 1, branches: 3 },
  pro: { projects: 20, agents: 25, memories: 20000, seats: 1, branches: 20 },
  team: { projects: 100, agents: 100, memories: 200000, seats: 25, branches: 100 },
  enterprise: { projects: null, agents: null, memories: null, seats: null, branches: null },
  internal: { projects: null, agents: null, memories: null, seats: null, branches: null },
} as const satisfies Record<string, Record<string, number | null>>;
export type PlanName = keyof typeof PLANS;
export type Meter = keyof (typeof PLANS)['free'];

export async function usageFor(tx: Tx, workspaceId: string): Promise<Record<Meter, number>> {
  const r = await tx.query<Record<Meter, string | number>>(
    `select (select count(*) from projects where workspace_id = $1 and archived_at is null) as projects,
            (select count(*) from agents where workspace_id = $1 and revoked_at is null) as agents,
            (select count(*) from memories where workspace_id = $1) as memories,
            (select count(*) from memberships where workspace_id = $1) as seats,
            (select count(*) from branches where workspace_id = $1 and archived_at is null) as branches`,
    [workspaceId],
  );
  const x = r.rows[0]!;
  return {
    projects: Number(x.projects),
    agents: Number(x.agents),
    memories: Number(x.memories),
    seats: Number(x.seats),
    branches: Number(x.branches),
  };
}

/** Throws `plan_limit` with an upgrade hint when creating one more `meter` would exceed the plan. Self-hosted installs set enforce=false. */
export async function checkEntitlement(
  tx: Tx,
  workspaceId: string,
  meter: Meter,
  enforce = true,
): Promise<void> {
  if (!enforce) return;
  const ws = await tx.query<{ plan: string }>('select plan from workspaces where id = $1', [workspaceId]);
  const plan = (ws.rows[0]?.plan ?? 'free') as PlanName;
  const limit = (PLANS[plan] ?? PLANS.free)[meter];
  if (limit === null) return;
  const used = (await usageFor(tx, workspaceId))[meter];
  if (used >= limit) {
    throw new BuiryError(
      'plan_limit',
      `You have used ${used} of ${limit} ${meter} on the ${plan} plan. Upgrade to add more.`,
      undefined,
      { meter, used, limit, plan },
    );
  }
}
