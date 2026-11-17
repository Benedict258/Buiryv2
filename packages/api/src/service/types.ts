import type { LearningConfig } from '@buiry/core';
import type { GatewayLike } from '@buiry/chain';
import type { AdmissionBudgets, WalrusMemoryAdapter } from '@buiry/storage';
import type { GatewayStatus } from '@buiry/chain';
import type { Db } from '../db/db.js';
import type { RuntimeNetworks } from './networks.js';
import type { StorageRegistry } from './byo-storage.js';

export type Permission = 'read' | 'write' | 'confirm';
export type Role = 'owner' | 'admin' | 'writer' | 'reader';

export type AgentPrincipal = {
  kind: 'agent';
  workspaceId: string;
  projectId: string;
  agentId: string;
  agentSlug: string;
  tool: string;
  permissions: Permission[];
  /** When set, the agent may write only this branch (and read main). */
  branchScope: string | null;
  sessionId: string;
};

export type UserPrincipal = {
  kind: 'user';
  workspaceId: string;
  userId: string;
  displayName: string;
  role: Role;
  /** Projects this member may access; null means all. */
  projectScope: string[] | null;
};

export type Principal = AgentPrincipal | UserPrincipal;

export interface GatewayPort extends GatewayLike {
  readonly defaultNetwork: string;
  status(): GatewayStatus;
  creditUsage(workspaceId: string): { used: number; limit: number } | null;
}

export interface ServiceDeps {
  db: Db;
  now: () => number;
  random: (n: number) => Uint8Array;
  /** Used to hash agent tokens (HMAC-SHA256). */
  secretKey: string;
  learning?: LearningConfig;
  adapter?: WalrusMemoryAdapter;
  budgets?: AdmissionBudgets;
  gateway?: GatewayPort;
  /** Upper bound for inline chain verification on write/check. */
  verifyTimeoutMs?: number;
  /** Maximum memory text length in characters. */
  maxTextLength?: number;
  /** Re-verify chain evidence older than this at check time. */
  reverifyAfterMs?: number;
  /**
   * How long `buiry_check` waits for re-verification before building the briefing (default 1500 ms). Slower
   * checks finish in the background and show at the next check; the briefing is never blocked on the chain longer.
   */
  checkReverifyBudgetMs?: number;
  /** Days until a newly issued agent token expires (BUIRY_AGENT_TOKEN_MAX_DAYS); unset or 0: no expiry. */
  agentTokenMaxDays?: number;
  /** BUIRY_RENEWAL=on: memories close to expiry are rewritten (renewal by rewrite). Default off. */
  renewalEnabled?: boolean;
  /** Per-project storage accounts (bring your own) and the managed-account tenancy guard. */
  storage?: StorageRegistry;
  /** Networks resolved at startup; `sui` is the deployment's Sui network when known. */
  networks?: RuntimeNetworks;
}

export const WRITE_PERMS: Permission[] = ['read', 'write'];
