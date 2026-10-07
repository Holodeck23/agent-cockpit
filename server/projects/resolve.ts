import type { Workspace } from './workspaces.ts'

// The one rule for "which folder does this workspace mean" (W12.2 M1, INTERFACES §5).
// A primary workspace is its project's own folder, exactly as before worktrees existed; only a
// worktree uses its own folder. A workspace that is unknown or no longer active is a typed refusal:
// the primary folder is never used in its place.

export type WorkspaceLookup = (workspaceId: string) => Workspace | undefined

export interface WorkspaceFolder {
  readonly cwd: string
  /** Absent for a conversation or request that predates workspaces: it means the project folder. */
  readonly workspaceId?: string
}
export interface WorkspaceRefusal { readonly refusal: string }

export const NO_SUCH_WORKSPACE = 'This workspace no longer exists. Continue in another workspace.'

export function workspaceFolder(lookup: WorkspaceLookup | undefined, projectPath: string, workspaceId?: string): WorkspaceFolder | WorkspaceRefusal {
  if (!workspaceId || !lookup) return { cwd: projectPath }
  const workspace = lookup(workspaceId)
  if (!workspace || workspace.lifecycle !== 'active') return { refusal: NO_SUCH_WORKSPACE }
  return { cwd: workspace.kind === 'primary' ? projectPath : workspace.cwd, workspaceId }
}

export const isRefusal = (result: WorkspaceFolder | WorkspaceRefusal): result is WorkspaceRefusal => 'refusal' in result

/** The refusal as an Error with an HTTP-friendly status, for callers that throw. */
export class WorkspaceRefusedError extends Error {
  readonly status = 409
}

export function requireWorkspaceFolder(lookup: WorkspaceLookup | undefined, projectPath: string, workspaceId?: string): WorkspaceFolder {
  const result = workspaceFolder(lookup, projectPath, workspaceId)
  if (isRefusal(result)) throw new WorkspaceRefusedError(result.refusal)
  return result
}
