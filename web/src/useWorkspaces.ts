import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type PendingOperation, type Project, type Workspace } from './api.ts'
import {
  createSelectionGuard, isActiveWorktree, loadSelected, resolveSelection, saveSelected, viewKey,
  type SelectionGuard, type WorkspaceSelection,
} from './workspaces.ts'

// The selected workspace per project (local to this window, remembered as the last one viewed) and
// the project's workspaces. Mac only: the phone has no picker and its routes are refused.

export interface Workspaces {
  /** What the window is looking at, resolved against what exists now. */
  readonly selection: WorkspaceSelection
  /** Registered worktrees that are active (the main checkout is the project itself). */
  readonly worktrees: readonly Workspace[]
  /** Interrupted creates the person can recover or dismiss. */
  readonly pending: readonly PendingOperation[]
  /** Any worktree was ever registered for the project: sends then name their workspace explicitly. */
  readonly hasWorktrees: boolean
  /** Every workspace record, for labels and folders by ID; undefined until the first answer. */
  readonly list: readonly Workspace[] | undefined
  /** Changes with each project/workspace choice; requests capture it through `guard`. */
  readonly guard: SelectionGuard
  /** The workspace to show (a worktree's ID, or undefined for the main checkout). */
  select(id: string | undefined): void
  refresh(): Promise<void>
  /** Resolves to the new worktree (and selects it); rejects with the server's message. */
  create(body: { name: string; base?: string; branch?: string }): Promise<Workspace>
  recover(operationId: string): Promise<void>
  dismiss(operationId: string): Promise<void>
}

interface Loaded { readonly projectId: string; readonly list: readonly Workspace[]; readonly pending: readonly PendingOperation[] }

export function useWorkspaces(project: Project | undefined, enabled: boolean): Workspaces {
  const path = project?.path
  const projectId = enabled ? project?.projectId : undefined
  const [loaded, setLoaded] = useState<Loaded>()
  const [, setTick] = useState(0)
  const guard = useRef(createSelectionGuard()).current

  const stored = path && enabled ? loadSelected(path) : undefined
  const list = loaded && loaded.projectId === projectId ? loaded.list : undefined
  const selection = useMemo(
    () => resolveSelection({ path: path ?? '', workspaceId: project?.workspaceId }, projectId ? list : [], stored),
    [path, project?.workspaceId, projectId, list, stored],
  )
  // A new generation whenever the project or the chosen workspace changes.
  guard.sync(viewKey(path, selection.id ?? ''))

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    try {
      const answer = await api.workspaces(projectId)
      setLoaded({ projectId, list: answer.workspaces, pending: answer.pending })
    } catch {
      // keep what is shown; a focus change reads it again
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) { setLoaded(undefined); return }
    let live = true
    const read = (): void => {
      api.workspaces(projectId).then(
        (answer) => { if (live) setLoaded({ projectId, list: answer.workspaces, pending: answer.pending }) },
        () => { /* keep what is shown; the next focus tries again */ },
      )
    }
    read()
    const onVisible = (): void => { if (document.visibilityState === 'visible') read() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { live = false; document.removeEventListener('visibilitychange', onVisible) }
  }, [projectId])

  const select = useCallback((id: string | undefined): void => {
    if (!path) return
    saveSelected(path, id)
    setTick((n) => n + 1)
  }, [path])

  const create = useCallback(async (body: { name: string; base?: string; branch?: string }): Promise<Workspace> => {
    if (!projectId) throw new Error('Open this project in Cockpit first.')
    const { workspace } = await api.createWorkspace(projectId, body)
    await refresh()
    if (path) { saveSelected(path, workspace.id); setTick((n) => n + 1) }
    return workspace
  }, [projectId, path, refresh])

  const recover = useCallback(async (operationId: string): Promise<void> => {
    const { workspace } = await api.recoverWorkspaceOperation(operationId)
    await refresh()
    if (path) { saveSelected(path, workspace.id); setTick((n) => n + 1) }
  }, [path, refresh])

  const dismiss = useCallback(async (operationId: string): Promise<void> => {
    await api.dismissWorkspaceOperation(operationId)
    await refresh()
  }, [refresh])

  const worktrees = useMemo(() => (list ?? []).filter(isActiveWorktree), [list])
  return {
    selection, worktrees, pending: loaded && loaded.projectId === projectId ? loaded.pending : [],
    hasWorktrees: (list ?? []).some((w) => w.kind === 'worktree'),
    list, guard, select, refresh, create, recover, dismiss,
  }
}
