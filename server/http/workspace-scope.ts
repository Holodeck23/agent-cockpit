import type { ProjectStore } from '../projects/store.ts'
import { NO_SUCH_WORKSPACE } from '../projects/resolve.ts'
import type { WorkspaceStore } from '../projects/workspaces.ts'
import { HttpError } from './json.ts'

// Which folder a desktop request means (W12.2 M1, INTERFACES §5). A request names a workspace by
// ID, or (legacy) a project by path, which means its primary workspace exactly as before. A workspace
// must exist, be active and belong to a project that is open; its folder is then the root for the
// containment checks of whichever route asked. A gone workspace is a typed refusal (409), never the primary.

export interface RequestScope {
  /** The open project's own path: grouping, shared documents, memory and the legacy key. */
  readonly projectPath: string
  /** The folder the route works in: the project folder for a primary workspace, the worktree's own otherwise. */
  readonly cwd: string
  /** The workspace asked for, or the project's primary when only a path was given (absent only when identity is unavailable). */
  readonly workspaceId?: string
}

export interface WorkspaceScope {
  /** Throws an HttpError: 400 nothing named, 404 project not open, 409 workspace gone or not that project's. */
  resolve(projectPath: string | undefined, workspaceId: string | undefined): RequestScope
  /** The workspace a conversation works in now: its own, or its project's primary for an older one. */
  currentOf(meta: { projectPath: string; workspaceId?: string }): string | undefined
}

export function createWorkspaceScope(projects: ProjectStore, workspaces: WorkspaceStore | undefined): WorkspaceScope {
  const primaryId = (projectPath: string): string | undefined => {
    try { return workspaces?.primaryFor(projectPath)?.workspace.id } catch { return undefined }
  }
  return {
    currentOf: (meta) => meta.workspaceId ?? primaryId(meta.projectPath),
    resolve(projectPath, workspaceId) {
      const open = projects.list()
      if (!workspaceId) {
        if (!projectPath) throw new HttpError(400, 'Which project?')
        if (!open.some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
        const primary = primaryId(projectPath)
        return { projectPath, cwd: projectPath, ...(primary ? { workspaceId: primary } : {}) }
      }
      const workspace = workspaces?.get(workspaceId)
      if (!workspace || workspace.lifecycle !== 'active') throw new HttpError(409, NO_SUCH_WORKSPACE)
      const project = open.find((p) => workspaces!.primaryFor(p.path)?.project.id === workspace.projectId)
      if (!project) throw new HttpError(404, 'Open this project first')
      if (projectPath && projectPath !== project.path) throw new HttpError(409, 'That workspace is not part of that project')
      return { projectPath: project.path, cwd: workspace.kind === 'primary' ? project.path : workspace.cwd, workspaceId }
    },
  }
}
