import { describe, expect, it } from 'vitest';
import { ownAccountReason } from './storage-text';

// Phase 9 C1: the banner says why a project needs its own Walrus Memory account, and says it truly.
describe('ownAccountReason', () => {
  it('preview: the deployment has no shared account at all', () => {
    expect(
      ownAccountReason({
        mode: 'managed',
        managedAllowed: false,
        needsOwnAccount: true,
        noSharedAccount: true,
      }),
    ).toBe(
      'This deployment has no shared storage account, so each project stores memories in its own Walrus Memory account.',
    );
  });
  it('a project set up to bring its own account', () => {
    expect(
      ownAccountReason({ mode: 'managed', managedAllowed: true, needsOwnAccount: true, requested: 'byo' }),
    ).toBe('This project stores memories in its own Walrus Memory account, which is not connected yet.');
  });
  it('the shared account serves another workspace', () => {
    expect(ownAccountReason({ mode: 'managed', managedAllowed: false, needsOwnAccount: true })).toBe(
      "This deployment's shared storage serves another workspace.",
    );
  });
});
