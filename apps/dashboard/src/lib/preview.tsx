import { Link, Navigate, NavLink } from 'react-router-dom';
import { CreditCard } from 'lucide-react';
import { Billing } from '../pages/WorkspacePages';

/**
 * Preview build (Phase 9 D6): `VITE_BUIRY_PREVIEW=1` at build time. Testers bring their own storage and nothing is
 * billed, so the billing page, its usage and seats bars, the plan chip and upgrade prompts are hidden. The code
 * stays; only this flag hides it. Read at call time so tests can switch it.
 */
export function isPreview(): boolean {
  return import.meta.env.VITE_BUIRY_PREVIEW === '1';
}

/** The workspace plan chip in the sidebar. */
export function PlanChip({ plan }: { plan: string }) {
  if (isPreview()) return null;
  return <span className="chip hide-collapsed">{plan}</span>;
}

/** The Billing link, in the sidebar (with a label span) or the phone tab bar. */
export function BillingNavLink({ ws, size, tab }: { ws: string; size: number; tab?: boolean }) {
  if (isPreview()) return null;
  return (
    <NavLink to={`/w/${ws}/billing`}>
      <CreditCard size={size} />
      {tab ? 'Billing' : <span className="t">Billing</span>}
    </NavLink>
  );
}

/** The billing route: the page in a normal build, back to projects in preview. */
export function BillingRoute() {
  if (isPreview()) return <Navigate to="../projects" replace />;
  return <Billing />;
}

/** The plan name and upgrade link after a plan-limit error; nothing in preview. */
export function PlanNote({ wsId, plan, limit }: { wsId: string; plan: string; limit: boolean }) {
  if (isPreview()) return null;
  return (
    <>
      {' '}
      ({plan} plan){limit && <Link to={`/w/${wsId}/billing`}> Upgrade</Link>}
    </>
  );
}
