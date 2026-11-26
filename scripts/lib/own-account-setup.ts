/**
 * Phase 14c: the in-process stack setup shared by the two-account live scripts (`scripts/live/byo-isolation.ts`,
 * `scripts/byo-live.ts`). The real server takes its mainnet opt-in from BUIRY_ALLOW_MAINNET (`server.ts`); a script's
 * own stack must take it from the same verified setting, or every mainnet own account is refused.
 */
import { createStack, setProjectStorage, type UserPrincipal } from '../../packages/api/src/index.js';
import type { ByoOpts } from '../../packages/api/src/service/byo-storage.js';
import { ScriptRefusal } from './errors.js';
import type { LiveRunNetwork } from './live-guard.js';

type Stack = Awaited<ReturnType<typeof createStack>>;

/**
 * Sets the stack's network and mainnet opt-in from the network the guard already checked. The opt-in is true only for
 * mainnet with BUIRY_ALLOW_MAINNET=1 exactly, never from the network alone; testnet leaves it off. Any other network is
 * refused before the stack is changed. Call it after `requireLiveNetwork`.
 */
export function applyLiveNetwork(
  deps: Stack['deps'],
  network: string,
  env: Record<string, string | undefined>,
): asserts network is LiveRunNetwork {
  if (network !== 'testnet' && network !== 'mainnet')
    throw new ScriptRefusal(
      `refused: live runs use testnet or mainnet; the settings name ${['devnet', 'localnet'].includes(network) ? network : 'an unrecognised network'}`,
    );
  deps.networks = { sui: network };
  deps.allowMainnet = network === 'mainnet' && env.BUIRY_ALLOW_MAINNET === '1';
}

/**
 * One tester for the isolation run: a workspace, a project on the run's network, and the project connected to the
 * tester's own account (`BYO_<side>_*`) through `setProjectStorage`, which validates the account and probes the relayer.
 * No write is made here.
 */
export async function setUpTester(
  s: Stack,
  o: {
    side: 'A' | 'B';
    run: string;
    network: LiveRunNetwork;
    env: Record<string, string | undefined>;
    probe: NonNullable<ByoOpts['probe']>;
    resolve?: ByoOpts['resolve'];
  },
) {
  const ws = await s.newWorkspace(`byo-isolation-${o.side}-${o.run}`);
  const prj = await s.newProject(ws.id, `iso-${o.side}-${o.run}`, { networks: [`sui:${o.network}`] });
  const admin: UserPrincipal = {
    kind: 'user',
    workspaceId: ws.id,
    userId: `usr_iso_${o.side}`,
    displayName: `tester ${o.side}`,
    role: 'owner',
    projectScope: null,
  };
  const cfg = {
    relayerUrl: o.env[`BYO_${o.side}_RELAYER_URL`]!,
    network: o.network,
    accountId: o.env[`BYO_${o.side}_ACCOUNT_ID`]!,
    delegateKey: o.env[`BYO_${o.side}_DELEGATE_KEY`]!,
  };
  const view = await s.db.tenant(ws.id, (tx) =>
    setProjectStorage(s.deps, tx, admin, prj.id, cfg, {
      probe: o.probe,
      ...(o.resolve ? { resolve: o.resolve } : {}),
    }),
  );
  return { ws, prj, admin, view };
}
