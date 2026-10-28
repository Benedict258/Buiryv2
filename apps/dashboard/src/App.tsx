import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from './lib/app';
import { signedOutRedirect } from './lib/guard';
import { WorkspaceLayout, ProjectLayout } from './components/Shell';
import { SignIn } from './pages/SignIn';
import { Onboarding } from './pages/Onboarding';
import { Projects } from './pages/Projects';
import { Overview } from './pages/Overview';
import { MemoryExplorer } from './pages/MemoryExplorer';
import { Timeline } from './pages/Timeline';
import { Branches } from './pages/Branches';
import { Agents } from './pages/Agents';
import { ActivityPage } from './pages/ActivityPage';
import { Alerts } from './pages/Alerts';
import { VerificationPage } from './pages/VerificationPage';
import { Handoffs } from './pages/Handoffs';
import { Briefing } from './pages/Briefing';
import { Packs } from './pages/Packs';
import { StoragePage } from './pages/StoragePage';
import { Settings } from './pages/Settings';
import { Team, Integrations, ApiTokens, Billing, Account, Notifications } from './pages/WorkspacePages';
import { Skeleton } from './components/ui';
import { Showcase } from './pages/Showcase';
import { AcceptInvite } from './pages/AcceptInvite';

function Home() {
  const { me } = useApp();
  if (!me) return null;
  const w = me.workspaces[0];
  return <Navigate to={w ? `/w/${w.id}/projects` : '/onboarding'} replace />;
}

export function App() {
  const { me, refreshMe } = useApp();
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    refreshMe()
      .catch((e: Error) => setFailure(e.message))
      .finally(() => setReady(true));
  }, [refreshMe]);
  useEffect(() => {
    if (!ready || me || failure) return;
    const to = signedOutRedirect(loc.pathname, loc.search);
    if (to) nav(to, { replace: true });
  }, [ready, me, failure, loc.pathname, loc.search, nav]);
  if (ready && failure && !me && !loc.pathname.startsWith('/showcase/'))
    return (
      <div className="auth-wrap">
        <div className="card auth-card col" role="alert">
          <h3>We could not load your account</h3>
          <p className="muted">{failure}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (!ready)
    return (
      <div style={{ padding: 32 }}>
        <Skeleton rows={3} />
      </div>
    );
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/auth/email" element={<Navigate to={`/signin${loc.search}`} replace />} />
      <Route path="/showcase/:pid" element={<Showcase />} />
      <Route path="/invite/:token" element={me ? <AcceptInvite /> : null} />
      <Route path="/onboarding" element={me ? <Onboarding /> : null} />
      <Route path="/" element={<Home />} />
      <Route path="/w/:ws" element={me ? <WorkspaceLayout /> : null}>
        <Route path="projects" element={<Projects />} />
        <Route path="team" element={<Team />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="api" element={<ApiTokens />} />
        <Route path="billing" element={<Billing />} />
        <Route path="account" element={<Account />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="p/:pid" element={<ProjectLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Overview />} />
          <Route path="memory" element={<MemoryExplorer />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="branches" element={<Branches />} />
          <Route path="agents" element={<Agents />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="verification" element={<VerificationPage />} />
          <Route path="handoffs" element={<Handoffs />} />
          <Route path="briefing" element={<Briefing />} />
          <Route path="packs" element={<Packs />} />
          <Route path="storage" element={<StoragePage />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route index element={<Navigate to="projects" replace />} />
      </Route>
      <Route
        path="*"
        element={
          <div className="auth-wrap">
            <div className="card auth-card col">
              <h3>Nothing buried here</h3>
              <p className="muted">That page does not exist.</p>
              <a className="btn primary" href="/">
                Go home
              </a>
            </div>
          </div>
        }
      />
    </Routes>
  );
}
