import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../git/branches.ts'
import { withRepoLock } from './repo-lock.ts'
import { canonicalPath, type Workspace, type WorkspaceStore } from './workspaces.ts'
import { parseWorktreeList, type GitWorktree } from './worktrees.ts'

// The end of a worktree (W12.4): remove, archive, restore, and what Git says about each registered
// one. No unique work is ever deleted: a worktree is removed only when it is clean (tracked,
// untracked AND ignored files) and every commit on it is also on another ref, with plain
// `git worktree remove` (never --force) under the repository lock; its branch is kept. Anything
// else is kept or archived (its folder stays exactly where it is, with recovery metadata). Nothing
// here prunes, recreates or deletes a folder on its own: a worktree Git no longer has is reported.

/** What Git says about a registered worktree right now. */
export type WorktreeHealth =
  | { readonly state: 'ok' }
  | { readonly state: 'missing'; readonly detail: string }
  | { readonly state: 'moved'; readonly detail: string; readonly path: string }
  | { readonly state: 'unlisted'; readonly detail: string }
  | { readonly state: 'branch-changed'; readonly detail: string; readonly branch?: string }

export interface UniqueWork {
  /** Tracked files with uncommitted changes (incl. staged and conflicted). */
  readonly changed: number
  readonly untracked: number
  /** Ignored files (build output, dependencies, local settings): never assumed disposable. */
  readonly ignored: number
  /** Commits on this worktree that no other branch, tag or remote has. */
  readonly commits: number
}

export interface RemovalCheck {
  readonly workspaceId: string
  readonly path: string
  readonly branch?: string
  readonly head?: string
  /** Why nothing can happen to it right now (work running in it, a Git operation, not a managed worktree). */
  readonly blockers: readonly string[]
  readonly unique: UniqueWork
  /** Git can remove it normally and nothing unique is lost. */
  readonly removable: boolean
  /** What was checked, so a Remove confirmed on an older check is refused. */
  readonly fingerprint: string
}

export type LifecycleRefusal =
  | { readonly code: 'unknown-workspace' }
  | { readonly code: 'not-a-worktree' }
  | { readonly code: 'not-active'; readonly lifecycle: string }
  | { readonly code: 'blocked'; readonly blockers: readonly string[] }
  | { readonly code: 'unique-work'; readonly unique: UniqueWork }
  | { readonly code: 'stale'; readonly detail: string }
  | { readonly code: 'not-restorable'; readonly detail: string }
  | { readonly code: 'not-missing' }
  | { readonly code: 'git-failed'; readonly detail: string }

export class LifecycleRefusalError extends Error {
  constructor(readonly refusal: LifecycleRefusal) { super(refusal.code) }
}
const refuse = (refusal: LifecycleRefusal): never => { throw new LifecycleRefusalError(refusal) }

export interface LifecycleDeps {
  readonly workspaces: WorkspaceStore
  /** Work Cockpit owns in that workspace right now, in words ("a conversation is working", "process dev is running"). */
  readonly activeIn: (workspace: Workspace) => readonly string[]
}

export interface WorktreeLifecycle {
  /** Each registered (not removed) worktree of the project as Git sees it; worktrees Git has that Cockpit did not register. */
  health(projectId: string): Promise<{ readonly worktrees: Readonly<Record<string, WorktreeHealth>>; readonly unregistered: readonly GitWorktree[] }>
  removalCheck(workspaceId: string): Promise<RemovalCheck>
  /** Normal Git removal of a clean, merged, idle managed worktree; `fingerprint` must match a fresh check. */
  remove(workspaceId: string, fingerprint: string): Promise<Workspace>
  /** Keeps the folder exactly as it is and takes the worktree out of use; history keeps its reference. */
  archive(workspaceId: string): Promise<Workspace>
  /** An archived worktree back in use, when Git still has it where it was. */
  restore(workspaceId: string): Promise<Workspace>
  /** A worktree whose folder is gone stops being offered; Git's own records are left for the person (no prune). */
  forget(workspaceId: string): Promise<Workspace>
}

const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
]

const out = async (cwd: string, args: readonly string[]): Promise<string | undefined> => {
  try { return (await run(cwd, args)).stdout } catch { return undefined }
}

/** Counts `git status --porcelain=v1 -z` entries by kind (a rename carries its old path as the next field). */
export function countStatus(output: string): Pick<UniqueWork, 'changed' | 'untracked' | 'ignored'> {
  const fields = output.split('\0').filter(Boolean)
  let changed = 0, untracked = 0, ignored = 0
  for (let i = 0; i < fields.length; i++) {
    const code = (fields[i] ?? '').slice(0, 2)
    if (code === '??') untracked++
    else if (code === '!!') ignored++
    else { changed++; if (/^[RC]/.test(code)) i++ }
  }
  return { changed, untracked, ignored }
}

export function createWorktreeLifecycle({ workspaces, activeIn }: LifecycleDeps): WorktreeLifecycle {
  const worktreeOf = (workspaceId: string): Workspace => {
    const workspace = workspaces.get(workspaceId) ?? refuse({ code: 'unknown-workspace' })
    if (workspace.kind !== 'worktree') refuse({ code: 'not-a-worktree' })
    return workspace
  }
  const primaryOf = (workspace: Workspace): Workspace =>
    workspaces.forProject(workspace.projectId).find((w) => w.kind === 'primary') ?? refuse({ code: 'unknown-workspace' })
  const listed = async (primary: Workspace): Promise<GitWorktree[]> =>
    parseWorktreeList((await out(primary.cwd, ['worktree', 'list', '--porcelain', '-z'])) ?? '')

  const healthOf = (workspace: Workspace, list: readonly GitWorktree[]): WorktreeHealth => {
    const here = list.find((w) => canonicalPath(w.path) === workspace.canonicalCwd || w.path === workspace.cwd)
    const exists = existsSync(workspace.cwd)
    if (here && exists) {
      if (workspace.branch && here.branch !== workspace.branch) {
        return { state: 'branch-changed', detail: `It is on ${here.branch ?? 'a detached HEAD'} now, not ${workspace.branch}.`, ...(here.branch ? { branch: here.branch } : {}) }
      }
      return { state: 'ok' }
    }
    const elsewhere = workspace.branch ? list.find((w) => w.branch === workspace.branch && canonicalPath(w.path) !== workspace.canonicalCwd) : undefined
    if (elsewhere && existsSync(elsewhere.path)) return { state: 'moved', path: elsewhere.path, detail: `Git has its branch ${workspace.branch} checked out at ${elsewhere.path}.` }
    if (exists) return { state: 'unlisted', detail: 'The folder is there, but Git does not list it as a worktree.' }
    return { state: 'missing', detail: here ? 'The folder is gone; Git still lists it (git worktree prune would forget it).' : 'The folder is gone and Git does not list it.' }
  }

  const check = async (workspace: Workspace): Promise<RemovalCheck> => {
    const blockers: string[] = []
    if (!workspace.managed) blockers.push('Cockpit did not create this worktree, so it does not remove it.')
    if (workspace.lifecycle !== 'active') blockers.push(`This worktree is ${workspace.lifecycle}.`)
    blockers.push(...activeIn(workspace))
    const exists = existsSync(workspace.cwd)
    if (!exists) blockers.push('Its folder is gone.')
    const head = exists ? (await out(workspace.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() : undefined
    const gitDir = exists ? (await out(workspace.cwd, ['rev-parse', '--absolute-git-dir']))?.trim() : undefined
    for (const [marker, operation] of IN_PROGRESS) if (gitDir && existsSync(join(gitDir, marker))) blockers.push(`A Git ${operation} is in progress in it.`)
    const status = exists ? (await out(workspace.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])) ?? '' : ''
    const counts = countStatus(status)
    // Commits only this worktree's branch holds: every other branch, tag and remote is "elsewhere".
    const branch = workspace.branch
    const commits = head
      ? Number((await out(workspace.cwd, ['rev-list', '--count', head, '--not', ...(branch ? [`--exclude=${branch}`] : []), '--branches', '--tags', '--remotes']))?.trim() ?? 'NaN')
      : 0
    const unique: UniqueWork = { ...counts, commits: Number.isFinite(commits) ? commits : 1 }
    const nothingUnique = unique.changed === 0 && unique.untracked === 0 && unique.ignored === 0 && unique.commits === 0
    const fingerprint = createHash('sha256').update(JSON.stringify([workspace.revision, head ?? '', status, unique.commits, blockers])).digest('hex').slice(0, 32)
    return {
      workspaceId: workspace.id, path: workspace.cwd, ...(branch ? { branch } : {}), ...(head ? { head } : {}),
      blockers, unique, removable: blockers.length === 0 && nothingUnique, fingerprint,
    }
  }

  const ended = (workspace: Workspace, reason: string, head?: string) => ({
    at: new Date().toISOString(), reason, path: workspace.cwd, ...(workspace.branch ? { branch: workspace.branch } : {}), ...(head ? { head } : {}),
  })
  const repoOf = (workspace: Workspace): string => workspace.gitCommonDir ?? primaryOf(workspace).gitCommonDir ?? workspace.cwd

  return {
    async health(projectId) {
      const all = workspaces.forProject(projectId)
      const primary = all.find((w) => w.kind === 'primary')
      if (!primary) return { worktrees: {}, unregistered: [] }
      const list = await listed(primary)
      const worktrees: Record<string, WorktreeHealth> = {}
      for (const w of all) if (w.kind === 'worktree' && w.lifecycle !== 'removed') worktrees[w.id] = healthOf(w, list)
      const known = new Set(all.map((w) => w.canonicalCwd))
      const unregistered = list.filter((g) => !known.has(canonicalPath(g.path)))
      return { worktrees, unregistered }
    },

    async removalCheck(workspaceId) {
      return check(worktreeOf(workspaceId))
    },

    async remove(workspaceId, fingerprint) {
      const workspace = worktreeOf(workspaceId)
      return withRepoLock(repoOf(workspace), async () => {
        // Checked again under the lock: what the person confirmed must still be what is there.
        const fresh = await check(worktreeOf(workspaceId))
        if (fresh.blockers.length) refuse({ code: 'blocked', blockers: fresh.blockers })
        if (!fresh.removable) refuse({ code: 'unique-work', unique: fresh.unique })
        if (fresh.fingerprint !== fingerprint) refuse({ code: 'stale', detail: 'The worktree changed after it was checked. Check it again.' })
        try {
          // Never --force: Git itself refuses a worktree with changes, untracked files or a lock.
          await run(primaryOf(workspace).cwd, ['worktree', 'remove', '--', workspace.cwd])
        } catch (error) {
          refuse({ code: 'git-failed', detail: (error as Error).message })
        }
        return workspaces.setLifecycle(workspaceId, 'removed', ended(workspace, 'Removed with Git: it was clean and every commit is on another branch.', fresh.head))
      })
    },

    async archive(workspaceId) {
      const workspace = worktreeOf(workspaceId)
      if (workspace.lifecycle !== 'active') refuse({ code: 'not-active', lifecycle: workspace.lifecycle })
      const busy = activeIn(workspace)
      if (busy.length) refuse({ code: 'blocked', blockers: busy })
      const head = existsSync(workspace.cwd) ? (await out(workspace.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() : undefined
      return workspaces.setLifecycle(workspaceId, 'archived', ended(workspace, 'Archived: its folder, branch and files are kept exactly as they were.', head))
    },

    async restore(workspaceId) {
      const workspace = worktreeOf(workspaceId)
      if (workspace.lifecycle !== 'archived') refuse({ code: 'not-restorable', detail: `This worktree is ${workspace.lifecycle}.` })
      const health = healthOf(workspace, await listed(primaryOf(workspace)))
      if (health.state !== 'ok') refuse({ code: 'not-restorable', detail: health.detail })
      return workspaces.setLifecycle(workspaceId, 'active')
    },

    async forget(workspaceId) {
      const workspace = worktreeOf(workspaceId)
      if (workspace.lifecycle === 'removed') return workspace
      const health = healthOf(workspace, await listed(primaryOf(workspace)))
      if (health.state !== 'missing') refuse({ code: 'not-missing' })
      return workspaces.setLifecycle(workspaceId, 'removed', ended(workspace, 'Forgotten: its folder was gone. Git\'s own records were left as they are.'))
    },
  }
}
