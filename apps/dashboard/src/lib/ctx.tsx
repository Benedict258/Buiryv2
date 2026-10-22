import { createContext, useContext } from 'react';
import type { Query } from './app';
import type { ProjectCard, Role, StatusOut } from './types';

export interface WorkspaceCtx {
  wsId: string;
  name: string;
  role: Role;
  plan: string;
  projects: Query<ProjectCard[]>;
}
export const WsContext = createContext<WorkspaceCtx | null>(null);
export const useWs = (): WorkspaceCtx => {
  const c = useContext(WsContext);
  if (!c) throw new Error('outside workspace');
  return c;
};

export interface ProjectCtx {
  projectId: string;
  project: ProjectCard | undefined;
  branch: string;
  setBranch: (b: string) => void;
  status: Query<StatusOut>;
  base: string;
  openMemory: (id: string) => void;
}
export const ProjContext = createContext<ProjectCtx | null>(null);
export const useProject = (): ProjectCtx => {
  const c = useContext(ProjContext);
  if (!c) throw new Error('outside project');
  return c;
};
