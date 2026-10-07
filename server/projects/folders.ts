import type { ProjectStore } from './store.ts'
import type { WorkspaceStore } from './workspaces.ts'

// The folders the desktop shell may act on for a page of Cockpit: an open project's own folder, and
// the folder of each ACTIVE worktree of an open project (W12.2 M1). A worktree is only ever reached
// through its registered record, never by a path someone supplies; the check stays an exact match.

type Projects = Pick<ProjectStore, 'list'>
type Workspaces = Pick<WorkspaceStore, 'primaryFor' | 'forProject'>

/** An open project's folder, or an active registered worktree of an open project. */
export function isKnownFolder(projects: Projects, workspaces: Workspaces | undefined, path: string): boolean {
  const open = projects.list()
  if (open.some((p) => p.path === path)) return true
  if (!workspaces) return false
  return open.some((p) => {
    const primary = workspaces.primaryFor(p.path)
    return primary !== undefined && workspaces.forProject(primary.project.id).some((w) => w.kind === 'worktree' && w.lifecycle === 'active' && w.cwd === path)
  })
}
