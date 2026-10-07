// Which workspace the window is looking at (W12.2 M1, INTERFACES §5). Pure helpers, no React, so
// they are unit-tested: resolving the person's saved choice against what exists now, which
// conversations ran where, where a send goes, and the guard that stops a slow answer for an old
// choice from replacing the view of the current one.
import type { ProcessInfo, ThreadMeta, ThreadSummary, Workspace } from './api.ts'
import { isWorking, needsYou } from './conversation-meta.ts'

export const MAIN_CHECKOUT = 'Main checkout'

/** The choice, resolved. `missing`: it was chosen but no longer exists; never quietly replaced by the main checkout. */
export interface WorkspaceSelection {
  readonly kind: 'primary' | 'worktree' | 'missing' | 'loading'
  /** The chosen workspace's ID (the primary's for the main checkout; absent only when identity is unavailable). */
  readonly id: string | undefined
  readonly workspace?: Workspace
  readonly label: string
  /** The folder the work happens in: the project folder for the main checkout, the worktree's own otherwise. */
  readonly folder: string
  /** What file, git and process requests carry: a worktree's ID; nothing for the main checkout (the path alone means it). */
  readonly scope: string | undefined
}

export interface ProjectRef { readonly path: string; readonly workspaceId?: string }

export const isActiveWorktree = (w: Workspace): boolean => w.kind === 'worktree' && w.lifecycle === 'active'
export const worktreeLabel = (w: Workspace): string => w.name ?? w.branch ?? 'Worktree'

/** `stored` is the saved choice (a workspace ID; absent or the primary's means the main checkout). `list` is undefined until loaded. */
export function resolveSelection(project: ProjectRef, list: readonly Workspace[] | undefined, stored: string | undefined): WorkspaceSelection {
  const primary = { kind: 'primary', id: project.workspaceId, label: MAIN_CHECKOUT, folder: project.path, scope: undefined } as const
  if (!stored || stored === project.workspaceId) return primary
  if (!list) return { kind: 'loading', id: stored, label: 'Loading…', folder: project.path, scope: stored }
  const found = list.find((w) => w.id === stored)
  if (found && isActiveWorktree(found)) return { kind: 'worktree', id: found.id, workspace: found, label: worktreeLabel(found), folder: found.cwd, scope: found.id }
  const name = found ? worktreeLabel(found) : undefined
  return { kind: 'missing', id: stored, ...(found ? { workspace: found } : {}), label: name ? `${name} (missing)` : 'Missing workspace', folder: project.path, scope: stored }
}

/** Whether panels may use the selection: loading and missing ones show a note instead. */
export const isUsable = (s: WorkspaceSelection): boolean => s.kind === 'primary' || s.kind === 'worktree'

/** A key for things a person keeps per workspace (drafts, open tabs): the main checkout's stays exactly the project path. */
export const scopedKey = (projectPath: string, s: Pick<WorkspaceSelection, 'kind' | 'scope'>): string =>
  s.kind === 'worktree' && s.scope ? `${projectPath}@${s.scope}` : projectPath

// ---- which conversations ran where ----

/** The workspace a conversation works in now. */
export const currentWorkspaceOf = (meta: Pick<ThreadMeta, 'workspaceId'>, primaryId: string | undefined): string | undefined => meta.workspaceId ?? primaryId

/** Every workspace the conversation has a session in: where it works now plus each saved binding. */
export function workspacesOf(meta: Pick<ThreadMeta, 'workspaceId' | 'bindings'>, primaryId: string | undefined): string[] {
  const now = currentWorkspaceOf(meta, primaryId)
  return [...new Set([...(now ? [now] : []), ...Object.keys(meta.bindings ?? {})])]
}

/** The conversations that ran in a workspace (one that ran in several shows under each). */
export function threadsIn(threads: readonly ThreadSummary[], workspaceId: string | undefined, primaryId: string | undefined): ThreadSummary[] {
  if (!workspaceId) return [...threads]
  return threads.filter((t) => workspacesOf(t.meta, primaryId).includes(workspaceId))
}

export interface WorkspaceActivity { readonly working: number; readonly needsYou: number }

/** Running / needs-you counts for the conversations working in a workspace now. */
export function activityIn(threads: readonly ThreadSummary[], workspaceId: string | undefined, primaryId: string | undefined): WorkspaceActivity {
  let working = 0
  let needs = 0
  for (const t of threads) {
    if (currentWorkspaceOf(t.meta, primaryId) !== workspaceId) continue
    if (isWorking(t.status)) working += 1
    if (needsYou(t)) needs += 1
  }
  return { working, needsYou: needs }
}

/** Whether a process belongs to the selected workspace (by the workspace it was started in, else by its folder). */
export function processIn(p: Pick<ProcessInfo, 'cwd' | 'workspaceId'>, s: Pick<WorkspaceSelection, 'id' | 'folder'>): boolean {
  if (p.workspaceId && s.id) return p.workspaceId === s.id
  return p.cwd === s.folder || p.cwd.startsWith(`${s.folder.replace(/\/+$/, '')}/`)
}

/** The workspace a file panel works in: a worktree's ID (absent: the main checkout) and its folder. */
export interface WorkspaceRef { readonly scope?: string; readonly folder: string }

/** The folder desktop file actions act on: a worktree's own folder for project files; the project for its documents. */
export const nativeFolder = (projectPath: string, space: 'project' | 'documents', workspace: WorkspaceRef | undefined): string =>
  space === 'project' && workspace?.scope ? workspace.folder : projectPath

/** What a conversation's view needs to know about workspaces (desktop; absent on the phone). */
export interface ThreadWorkspace {
  /** The selected workspace's worktree ID for panel requests; absent for the main checkout. */
  readonly scope: string | undefined
  readonly folder: string
  readonly target: SendTarget
  /** Where the conversation works now. */
  readonly currentLabel: string
  /** Shown only once the project has a worktree. */
  readonly showLabel: boolean
  /** The next message continues the conversation in this workspace instead of the one it last worked in. */
  readonly moves?: { readonly to: string; readonly from: string }
}

// ---- where a send goes ----

export type SendTarget = { readonly ok: true; readonly workspaceId?: string } | { readonly ok: false; readonly reason: string }

/**
 * The workspace a message or new conversation targets. Once the project has any worktree (or the
 * conversation has run in more than one workspace) it is always explicit; a selection that is gone
 * or still loading refuses, never falling back to the main checkout.
 */
export function sendTarget(s: WorkspaceSelection, hasWorktrees: boolean, meta?: Pick<ThreadMeta, 'bindings'>): SendTarget {
  if (s.kind === 'loading') return { ok: false, reason: 'Loading workspaces…' }
  if (s.kind === 'missing') return { ok: false, reason: `${s.label.replace(/ \(missing\)$/, '')} no longer exists. Choose another workspace to continue.` }
  const explicit = hasWorktrees || Object.keys(meta?.bindings ?? {}).length > 0
  return explicit && s.id ? { ok: true, workspaceId: s.id } : { ok: true }
}

/** The phone has no workspace picker: it names the conversation's own current workspace once it has more than one. */
export const phoneWorkspaceId = (meta: Pick<ThreadMeta, 'workspaceId' | 'bindings'>): string | undefined =>
  Object.keys(meta.bindings ?? {}).length > 0 ? meta.workspaceId : undefined

/** The folder for a workspace by ID (a page's browser data lives with its folder); the project's own when it is not an active worktree. */
export function folderOf(list: readonly Workspace[] | undefined, project: ProjectRef, workspaceId: string | undefined): string {
  const found = workspaceId ? list?.find((w) => w.id === workspaceId) : undefined
  return found && isActiveWorktree(found) ? found.cwd : project.path
}

/** The name a workspace goes by in the UI. */
export function labelOf(list: readonly Workspace[] | undefined, project: ProjectRef, workspaceId: string | undefined): string {
  if (!workspaceId || workspaceId === project.workspaceId) return MAIN_CHECKOUT
  const found = list?.find((w) => w.id === workspaceId)
  return found ? (isActiveWorktree(found) ? worktreeLabel(found) : `${worktreeLabel(found)} (missing)`) : 'Missing workspace'
}

// ---- default names ----

/** What a branch is called when the person does not type one: codex/<name as a slug> (matches the server's default). */
export function branchSuggestion(prefix: string, name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return `${prefix}${slug || '<name>'}`
}

// ---- stale answers ----

/**
 * One generation per view: project, workspace and (for a conversation) thread. A request captures
 * the generation when it starts; when the view changes the generation moves on, and `begin()`'s
 * check says false from then on, so a late answer cannot replace the newer view.
 */
export interface SelectionGuard {
  /** Moves to a new generation if the view's key changed; returns the generation. */
  sync(key: string): number
  /** Captures the current generation: call the result when the answer arrives. */
  begin(): () => boolean
  readonly generation: number
}

export function createSelectionGuard(): SelectionGuard {
  let generation = 0
  let current: string | undefined
  return {
    sync(key) {
      if (key !== current) { current = key; generation += 1 }
      return generation
    },
    begin() {
      const mine = generation
      return () => mine === generation
    },
    get generation() { return generation },
  }
}

export const viewKey = (...parts: ReadonlyArray<string | undefined>): string => parts.map((p) => p ?? '').join('|')

// ---- the saved choice (local to this window, per project) ----

const SELECTED_KEY = 'cockpit:workspace'

export function loadSelected(projectPath: string): string | undefined {
  try { return localStorage.getItem(`${SELECTED_KEY}:${projectPath}`) || undefined } catch { return undefined }
}

export function saveSelected(projectPath: string, id: string | undefined): void {
  try {
    if (id) localStorage.setItem(`${SELECTED_KEY}:${projectPath}`, id)
    else localStorage.removeItem(`${SELECTED_KEY}:${projectPath}`)
  } catch {
    // not remembered
  }
}
