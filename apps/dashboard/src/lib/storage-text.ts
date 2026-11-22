import type { ProjectStorageView } from './types';

/** Why a project needs its own Walrus Memory account, for the banner shown until one is connected (Phase 9 C1). */
export function ownAccountReason(v: ProjectStorageView): string {
  if (v.noSharedAccount)
    return 'This deployment has no shared storage account, so each project stores memories in its own Walrus Memory account.';
  if (v.requested === 'byo')
    return 'This project stores memories in its own Walrus Memory account, which is not connected yet.';
  return "This deployment's shared storage serves another workspace.";
}
