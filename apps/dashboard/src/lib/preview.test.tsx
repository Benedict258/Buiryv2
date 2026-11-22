import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BillingNavLink, BillingRoute, PlanChip, PlanNote, isPreview } from './preview';

// Phase 9 D6: the preview build (VITE_BUIRY_PREVIEW=1) shows no billing page, no seats or usage bars and no plan
// chip. The code stays; only the preview build hides it.

const html = (n: ReactNode) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={['/w/wsp_1/billing']}>{n}</MemoryRouter>);
afterEach(() => vi.unstubAllEnvs());

describe('normal build', () => {
  it('shows the plan chip, the billing link and the plan note', () => {
    expect(isPreview()).toBe(false);
    expect(html(<PlanChip plan="free" />)).toContain('>free<');
    expect(html(<BillingNavLink ws="wsp_1" size={16} />)).toContain('href="/w/wsp_1/billing"');
    expect(html(<PlanNote wsId="wsp_1" plan="free" limit />)).toContain('Upgrade');
  });
});

describe('preview build', () => {
  it('shows none of them, and the billing route renders no billing page', () => {
    vi.stubEnv('VITE_BUIRY_PREVIEW', '1');
    expect(isPreview()).toBe(true);
    expect(html(<PlanChip plan="free" />)).toBe('');
    expect(html(<BillingNavLink ws="wsp_1" size={16} />)).toBe('');
    expect(html(<PlanNote wsId="wsp_1" plan="free" limit />)).toBe('');
    expect(html(<BillingRoute />)).not.toMatch(/Billing|Plan|usage|seats/i);
  });
});
