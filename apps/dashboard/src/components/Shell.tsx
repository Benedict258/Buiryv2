import { useContext, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity as ActivityIcon,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  ChevronsUpDown,
  CircleHelp,
  CreditCard,
  FileStack,
  FolderKanban,
  GitBranch,
  HardDrive,
  Handshake,
  KeyRound,
  LayoutDashboard,
  Menu,
  Moon,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Brain,
  FileText,
  LogOut,
  User,
  PanelLeft,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useProjectStream, useQuery } from '../lib/app';
import { WsContext, ProjContext } from '../lib/ctx';
const WC = WsContext;
const PC = ProjContext;
import type { Flag, ProjectCard, StatusOut } from '../lib/types';
import { Banner, BranchPill, Popover, Toasts } from './ui';
import { CommandPalette } from './CommandPalette';
import { MemoryDrawer } from '../pages/MemoryDrawer';
import { initials } from '../lib/format';

export function WorkspaceLayout() {
  const { ws, pid } = useParams();
  const { me, collapsed, setCollapsed, setPalette, theme, toggleTheme, signOut, live } = useApp();
  const nav = useNavigate();
  const wsInfo = me?.workspaces.find((w) => w.id === ws);
  const projects = useQuery(() => api<ProjectCard[]>(`/v1/workspaces/${ws}/projects`), [ws], { live: true });
  const [filter, setFilter] = useState('');
  const value = useMemo(
    () =>
      wsInfo ? { wsId: wsInfo.id, name: wsInfo.name, role: wsInfo.role, plan: wsInfo.plan, projects } : null,
    [wsInfo, projects],
  );
  if (!value) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card col">
          <h3>Workspace not found</h3>
          <p className="muted">You are not a member of this workspace, or it does not exist.</p>
          <Link className="btn primary" to="/">
            Go to your workspaces
          </Link>
        </div>
      </div>
    );
  }
  const list = (projects.data ?? []).filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  const liveWord =
    live === 'on'
      ? 'Live updates connected'
      : live === 'retry'
        ? 'Reconnecting to live updates'
        : 'Live updates off';
  return (
    <WsContext.Provider value={value}>
      <div className={`shell${collapsed ? ' collapsed' : ''}`}>
        <aside className="sidebar" aria-label="Sidebar">
          <div className="head">
            <Popover
              trigger={({ toggle }) => (
                <button className="navbtn" style={{ padding: 4 }} onClick={toggle} aria-haspopup="menu">
                  <span className="avatar" aria-hidden>
                    {initials(value.name)}
                  </span>
                  <span className="t grow trunc" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    {value.name}
                  </span>
                  <span className="chip hide-collapsed">{value.plan}</span>
                  <ChevronsUpDown size={14} className="hide-collapsed" aria-hidden />
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="label" style={{ padding: '4px 12px' }}>
                    Workspaces
                  </div>
                  {me?.workspaces.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => {
                        close();
                        nav(`/w/${w.id}/projects`);
                      }}
                      className={w.id === ws ? 'on' : ''}
                    >
                      <span className="avatar" aria-hidden>
                        {initials(w.name)}
                      </span>
                      <span className="grow">{w.name}</span>
                      <span className="chip">{w.role}</span>
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      close();
                      nav('/onboarding');
                    }}
                  >
                    <Plus size={14} /> Create workspace
                  </button>
                  <button
                    onClick={() => {
                      close();
                      nav(`/w/${ws}/team`);
                    }}
                  >
                    <Settings size={14} /> Workspace settings
                  </button>
                </>
              )}
            </Popover>
          </div>
          <div className="scroll nav">
            <div className="nav-sec label hide-collapsed">Projects</div>
            <input
              className="inp hide-collapsed"
              placeholder="Search projects"
              aria-label="Search projects"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ margin: '0 0 6px', width: '100%' }}
            />
            <NavLink to={`/w/${ws}/projects`} end>
              <FolderKanban size={16} />
              <span className="t">All projects</span>
            </NavLink>
            {list.map((p) => (
              <NavLink key={p.id} to={`/w/${ws}/p/${p.id}/overview`}>
                <Brain size={16} />
                <span className="t trunc">{p.name}</span>
              </NavLink>
            ))}
            {pid && <SideProjectNav ws={ws!} pid={pid} />}
            <div className="nav-sec label hide-collapsed">Workspace</div>
            <NavLink to={`/w/${ws}/team`}>
              <Users size={16} />
              <span className="t">Team</span>
            </NavLink>
            <NavLink to={`/w/${ws}/integrations`}>
              <Plug size={16} />
              <span className="t">Integrations</span>
            </NavLink>
            <NavLink to={`/w/${ws}/api`}>
              <KeyRound size={16} />
              <span className="t">API tokens</span>
            </NavLink>
            <NavLink to={`/w/${ws}/billing`}>
              <CreditCard size={16} />
              <span className="t">Billing</span>
            </NavLink>
          </div>
          <div className="foot nav">
            <a href="https://github.com/benedict258/buiryv2/tree/main/docs" target="_blank" rel="noreferrer">
              <BookOpen size={16} />
              <span className="t">Docs</span>
            </a>
            <button className="navbtn" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span className="t">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
            </button>
            <button className="navbtn" onClick={() => setCollapsed(!collapsed)}>
              <PanelLeft size={16} />
              <span className="t">Collapse</span>
            </button>
            <Popover
              align="left"
              trigger={({ toggle }) => (
                <button className="navbtn" onClick={toggle}>
                  <User size={16} />
                  <span className="t trunc">{me?.displayName ?? me?.email ?? 'Account'}</span>
                </button>
              )}
            >
              {(close) => (
                <>
                  <button
                    onClick={() => {
                      close();
                      nav(`/w/${ws}/account`);
                    }}
                  >
                    <Settings size={14} /> Account settings
                  </button>
                  <button
                    onClick={async () => {
                      close();
                      await signOut();
                      nav('/signin');
                    }}
                  >
                    <LogOut size={14} /> Sign out
                  </button>
                </>
              )}
            </Popover>
          </div>
        </aside>
        <header className="topbar">
          <Crumbs />
          <button
            className="searchbtn"
            onClick={() => setPalette(true)}
            aria-label="Search and command palette"
          >
            <Search size={14} />
            <span>Search memories, agents, actions</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="row" style={{ marginLeft: 'auto' }}>
            <span className="row small muted" title={liveWord}>
              <i className={`live-dot ${live}`} aria-hidden />
              <span className="sr-only">{liveWord}</span>
            </span>
            <button
              className="btn ghost icon"
              aria-label="Notifications"
              onClick={() => nav(`/w/${ws}/notifications`)}
            >
              <Bell size={16} />
            </button>
            <a
              className="btn ghost icon"
              aria-label="Help"
              href="https://github.com/benedict258/buiryv2/tree/main/docs"
              target="_blank"
              rel="noreferrer"
            >
              <CircleHelp size={16} />
            </a>
          </div>
        </header>
        <main className="main" id="main">
          <Outlet />
        </main>
        <nav className="bottomtabs" aria-label="Primary">
          <ProjectTabs />
        </nav>
        <Toasts />
        <CommandPalette />
      </div>
    </WsContext.Provider>
  );
}

function Crumbs() {
  const { ws, pid } = useParams();
  const { me } = useApp();
  const w = me?.workspaces.find((x) => x.id === ws);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to={`/w/${ws}/projects`} className="trunc" style={{ color: 'inherit' }}>
        {w?.name ?? 'Workspace'}
      </Link>
      {pid && (
        <>
          <span aria-hidden>/</span>
          <ProjName pid={pid} />
        </>
      )}
      <BranchSlot />
    </nav>
  );
}
function ProjName({ pid }: { pid: string }) {
  const { projects } = useWsSafe();
  const p = projects?.data?.find((x) => x.id === pid);
  return <span className="cur trunc">{p?.name ?? pid}</span>;
}
function useWsSafe() {
  const c = useContext(WC);
  return { projects: c?.projects };
}
function BranchSlot() {
  const p = useContext(PC);
  if (!p) return null;
  return <BranchSwitch />;
}
function BranchSwitch() {
  const p = useContext(PC)!;
  const branches = useQuery(
    () => api<{ branches: { slug: string; protected: boolean }[] }>(`/v1/projects/${p.projectId}/branches`),
    [p.projectId],
  );
  const cur = branches.data?.branches.find((b) => b.slug === p.branch);
  return (
    <Popover
      trigger={({ toggle }) => (
        <button
          className="btn ghost sm"
          onClick={toggle}
          aria-haspopup="menu"
          aria-label={`Branch ${p.branch}, switch`}
          style={{ padding: 0 }}
        >
          <BranchPill name={p.branch} locked={cur?.protected} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="label" style={{ padding: '4px 12px' }}>
            Switch branch
          </div>
          {(branches.data?.branches ?? [{ slug: 'main', protected: true }]).map((b) => (
            <button
              key={b.slug}
              className={b.slug === p.branch ? 'on' : ''}
              onClick={() => {
                p.setBranch(b.slug);
                close();
              }}
            >
              <GitBranch size={14} /> <span className="mono">{b.slug}</span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

const PROJECT_NAV = [
  ['overview', 'Overview', LayoutDashboard],
  ['memory', 'Memory', Brain],
  ['timeline', 'Timeline', BarChart3],
  ['branches', 'Branches', GitBranch],
  ['agents', 'Agents', Bot],
  ['activity', 'Activity', ActivityIcon],
  ['alerts', 'Alerts', Bell],
  ['verification', 'Verification', ShieldCheck],
  ['handoffs', 'Handoffs', Handshake],
  ['briefing', 'Briefing', FileText],
  ['packs', 'Packs', FileStack],
  ['storage', 'Storage', HardDrive],
  ['settings', 'Settings', Settings],
] as const;

function ProjectTabs() {
  const { ws, pid } = useParams();
  if (!pid)
    return (
      <>
        <NavLink to={`/w/${ws}/projects`}>
          <FolderKanban size={18} />
          Projects
        </NavLink>
        <NavLink to={`/w/${ws}/team`}>
          <Users size={18} />
          Team
        </NavLink>
        <NavLink to={`/w/${ws}/integrations`}>
          <Plug size={18} />
          Integrations
        </NavLink>
        <NavLink to={`/w/${ws}/billing`}>
          <CreditCard size={18} />
          Billing
        </NavLink>
        <NavLink to={`/w/${ws}/account`}>
          <Menu size={18} />
          More
        </NavLink>
      </>
    );
  const b = `/w/${ws}/p/${pid}`;
  return (
    <>
      <NavLink to={`${b}/overview`}>
        <LayoutDashboard size={18} />
        Overview
      </NavLink>
      <NavLink to={`${b}/memory`}>
        <Brain size={18} />
        Memory
      </NavLink>
      <NavLink to={`${b}/alerts`}>
        <Bell size={18} />
        Alerts
      </NavLink>
      <NavLink to={`${b}/activity`}>
        <ActivityIcon size={18} />
        Activity
      </NavLink>
      <NavLink to={`${b}/settings`}>
        <Menu size={18} />
        More
      </NavLink>
    </>
  );
}

/** Project layout: project nav, degraded banner, live stream and the memory drawer. */
export function ProjectLayout() {
  const { ws, pid } = useParams<{ ws: string; pid: string }>();
  const wsCtx = useContext(WC)!;
  const [sp, setSp] = useSearchParams();
  const branch = sp.get('branch') ?? 'main';
  const openId = sp.get('memory');
  const nav = useNavigate();
  const status = useQuery(() => api<StatusOut>(`/v1/projects/${pid}/status`), [pid], {
    live: true,
    refreshMs: 30_000,
  });
  useProjectStream(pid);
  const project = wsCtx.projects.data?.find((p) => p.id === pid);
  const base = `/w/${ws}/p/${pid}`;
  const value = useMemo(
    () => ({
      projectId: pid!,
      project,
      branch,
      status,
      base,
      setBranch: (b: string) =>
        setSp(
          (s) => {
            const n = new URLSearchParams(s);
            if (b === 'main') n.delete('branch');
            else n.set('branch', b);
            return n;
          },
          { replace: true },
        ),
      openMemory: (id: string) =>
        setSp((s) => {
          const n = new URLSearchParams(s);
          n.set('memory', id);
          return n;
        }),
    }),
    [pid, project, branch, status, base, setSp],
  );
  const s = status.data;
  const degraded: string[] = [];
  if (s && ['degraded', 'paused', 'unreachable'].includes(s.relayer.state))
    degraded.push('Storage is slow or unavailable. New memories are queued and reads come from cache.');
  if (s && s.gateway.state === 'degraded')
    degraded.push('Chain checks are unavailable. Existing results are shown with their age.');
  return (
    <ProjContext.Provider value={value}>
      {degraded.map((d) => (
        <Banner key={d} kind="warning" full action={<Link to={`${base}/storage`}>Storage health</Link>}>
          {d}
        </Banner>
      ))}
      <Outlet />
      <MemoryDrawer
        id={openId}
        onClose={() =>
          setSp(
            (s2) => {
              const n = new URLSearchParams(s2);
              n.delete('memory');
              return n;
            },
            { replace: true },
          )
        }
        onNavigate={(id) => nav(`${base}/memory?memory=${id}`)}
      />
    </ProjContext.Provider>
  );
}

function SideProjectNav({ ws, pid }: { ws: string; pid: string }) {
  const flags = useQuery(() => api<Flag[]>(`/v1/projects/${pid}/flags`), [pid], { live: true });
  const open = flags.data?.filter((f) => f.state === 'open').length ?? 0;
  return (
    <>
      <div className="nav-sec label hide-collapsed">Project</div>
      {PROJECT_NAV.map(([id, label, Icon]) => (
        <NavLink key={id} to={`/w/${ws}/p/${pid}/${id}`}>
          <Icon size={16} aria-hidden />
          <span className="t">{label}</span>
          {id === 'alerts' && open > 0 && (
            <span className="badge-n" aria-label={`${open} open`}>
              {open}
            </span>
          )}
        </NavLink>
      ))}
    </>
  );
}
