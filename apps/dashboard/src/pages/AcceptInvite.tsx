import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { Banner, Button } from '../components/ui';

/** Opened from an invitation link by a signed-in person: joins the workspace, then opens it. */
export function AcceptInvite() {
  const { token } = useParams();
  const { refreshMe } = useApp();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ workspaceId: string }>('/v1/invitations/accept', { method: 'POST', body: { token } })
      .then(async (r) => {
        await refreshMe();
        if (live) nav(`/w/${r.workspaceId}/projects`, { replace: true });
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [token, nav, refreshMe]);
  return (
    <div className="auth-wrap">
      <div className="card auth-card col">
        <h3>Joining workspace</h3>
        {err ? (
          <>
            <Banner kind="error">{err}</Banner>
            <Button onClick={() => nav('/')}>Go to your workspaces</Button>
          </>
        ) : (
          <p className="muted">Accepting your invitation…</p>
        )}
      </div>
    </div>
  );
}
