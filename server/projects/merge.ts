import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { run } from '../git/branches.ts'
import { withRepoLock } from './repo-lock.ts'
import type { Workspace, WorkspaceStore } from './workspaces.ts'
import { parseWorktreeList } from './worktrees.ts'

// Merge back (W12.3): a worktree's branch into the branch its main checkout has checked out, with
// Git's own merge, under the repository lock. What the person approved (both HEADs, the target
// branch) is checked again just before Git starts; anything different is refused, never merged.
// Every merge is journaled before Git runs: a conflict stays a recorded state with Continue and
// Abort, and a crash mid-merge reopens that state; nothing is ever merged twice. No push, no branch
// deletion, no worktree removal: those stay separate decisions.

export type MergeMode = 'up-to-date' | 'fast-forward' | 'merge'

export interface MergePreflight {
  readonly sourceWorkspaceId: string
  readonly targetWorkspaceId: string
  readonly sourceBranch?: string
  readonly sourceHead: string
  readonly targetBranch?: string
  readonly targetHead: string
  /** The branch the worktree was created from, when the main checkout has moved to another since. */
  readonly createdFromBranch?: string
  readonly mode: MergeMode
  readonly commits: number
  readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>
  /** Why it cannot merge right now, in words. */
  readonly blockers: readonly string[]
  /** A merge commit needs a Git identity; absent, this says what to set (Cockpit never changes it). */
  readonly identity?: string
  readonly fingerprint: string
  /** A merge of this worktree that stopped part way and waits for Continue or Abort. */
  readonly open?: MergeOperationView
}

const operationSchema = z.object({
  id: z.uuid(),
  repo: z.string(),
  sourceWorkspaceId: z.uuid(),
  targetWorkspaceId: z.uuid(),
  targetCwd: z.string(),
  sourceBranch: z.string().optional(),
  sourceHead: z.string(),
  targetBranch: z.string().optional(),
  targetHeadBefore: z.string(),
  mode: z.enum(['fast-forward', 'merge']),
  stage: z.enum(['started', 'conflict', 'merged', 'aborted', 'failed']),
  conflicts: z.array(z.string()).default([]),
  resultHead: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
type Operation = z.output<typeof operationSchema>
export type MergeOperationView = Pick<Operation, 'id' | 'sourceWorkspaceId' | 'targetWorkspaceId' | 'sourceBranch' | 'targetBranch' | 'sourceHead' | 'targetHeadBefore' | 'mode' | 'stage' | 'conflicts' | 'resultHead' | 'error'>

export type MergeRefusal =
  | { readonly code: 'unknown-workspace' }
  | { readonly code: 'not-a-worktree' }
  | { readonly code: 'blocked'; readonly blockers: readonly string[] }
  | { readonly code: 'stale'; readonly detail: string }
  | { readonly code: 'up-to-date' }
  | { readonly code: 'identity'; readonly detail: string }
  | { readonly code: 'unknown-operation' }
  | { readonly code: 'not-in-conflict'; readonly stage: string }
  | { readonly code: 'still-conflicted'; readonly paths: readonly string[] }
  | { readonly code: 'unsafe'; readonly detail: string }
  | { readonly code: 'git-failed'; readonly detail: string }

export class MergeRefusalError extends Error {
  constructor(readonly refusal: MergeRefusal) { super(refusal.code) }
}
const refuse = (refusal: MergeRefusal): never => { throw new MergeRefusalError(refusal) }

export interface MergeDeps {
  readonly workspaces: WorkspaceStore
  /** Work Cockpit owns in that workspace right now, in words. */
  readonly activeIn: (workspace: Workspace) => readonly string[]
}

export interface MergeOptions {
  /** Test seam: runs after the journal says "started" and before Git merges (a crash point). */
  readonly beforeMerge?: () => void
}

export interface MergeService {
  preflight(sourceWorkspaceId: string): Promise<MergePreflight>
  merge(sourceWorkspaceId: string, fingerprint: string): Promise<MergeOperationView>
  /** Commits a resolved conflict: refused while any path is still unmerged. */
  continue(operationId: string): Promise<MergeOperationView>
  /** Git's own abort, only for this recorded merge; refused when the repository no longer matches it. */
  abort(operationId: string): Promise<MergeOperationView>
}

const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
]
const MERGE_TIMEOUT_MS = 120_000

const out = async (cwd: string, args: readonly string[]): Promise<string | undefined> => {
  try { return (await run(cwd, args)).stdout.trim() } catch { return undefined }
}
const view = ({ id, sourceWorkspaceId, targetWorkspaceId, sourceBranch, targetBranch, sourceHead, targetHeadBefore, mode, stage, conflicts, resultHead, error }: Operation): MergeOperationView =>
  ({ id, sourceWorkspaceId, targetWorkspaceId, ...(sourceBranch ? { sourceBranch } : {}), ...(targetBranch ? { targetBranch } : {}), sourceHead, targetHeadBefore, mode, stage, conflicts,
    ...(resultHead ? { resultHead } : {}), ...(error ? { error } : {}) })

export function createMergeService(root: string, { workspaces, activeIn }: MergeDeps, options: MergeOptions = {}): MergeService {
  const dir = join(root, 'merge-operations')
  const save = (operation: Operation): Operation => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${operation.id}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(operation, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    return operation
  }
  const advance = (operation: Operation, change: Partial<Operation>): Operation => save({ ...operation, ...change, updatedAt: new Date().toISOString() })
  const load = (id: string): Operation | undefined => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined
    try { return operationSchema.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))) } catch { return undefined }
  }
  const all = (): Operation[] => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    return names.filter((n) => n.endsWith('.json')).flatMap((n) => { const op = load(n.slice(0, -5)); return op ? [op] : [] })
  }

  const sourceOf = (id: string): Workspace => {
    const source = workspaces.get(id) ?? refuse({ code: 'unknown-workspace' })
    if (source.kind !== 'worktree') refuse({ code: 'not-a-worktree' })
    return source
  }
  const targetOf = (source: Workspace): Workspace =>
    (source.createdFrom ? workspaces.get(source.createdFrom) : undefined) ?? workspaces.forProject(source.projectId).find((w) => w.kind === 'primary') ?? refuse({ code: 'unknown-workspace' })
  const gitDirOf = async (cwd: string): Promise<string | undefined> => out(cwd, ['rev-parse', '--absolute-git-dir'])
  const unmerged = async (cwd: string): Promise<string[]> =>
    [...new Set(((await out(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])) ?? '').split('\0').filter(Boolean))]

  /**
   * A journaled merge that did not finish, as the repository shows it now: a conflict waiting, done,
   * or not started. Read on every look, so a crash part way reopens exactly where Git is.
   */
  const settle = async (operation: Operation): Promise<Operation> => {
    if (operation.stage !== 'started') return operation
    const gitDir = await gitDirOf(operation.targetCwd)
    const mergeHead = gitDir && existsSync(join(gitDir, 'MERGE_HEAD')) ? readFileSync(join(gitDir, 'MERGE_HEAD'), 'utf8').trim() : undefined
    if (mergeHead === operation.sourceHead) return advance(operation, { stage: 'conflict', conflicts: await unmerged(operation.targetCwd) })
    const head = await out(operation.targetCwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    const contains = head !== undefined && head !== operation.targetHeadBefore
      && await run(operation.targetCwd, ['merge-base', '--is-ancestor', operation.sourceHead, head]).then(() => true, () => false)
    if (head && contains) return advance(operation, { stage: 'merged', resultHead: head })
    return advance(operation, { stage: 'failed', error: 'Cockpit stopped before Git merged; nothing was merged. Check again and merge.' })
  }
  const openFor = async (sourceId: string): Promise<Operation | undefined> => {
    for (const op of all().filter((o) => o.sourceWorkspaceId === sourceId && (o.stage === 'started' || o.stage === 'conflict'))) {
      const settled = await settle(op)
      if (settled.stage === 'conflict') return settled
    }
    return undefined
  }

  const preflight = async (sourceId: string): Promise<MergePreflight> => {
    const source = sourceOf(sourceId)
    const target = targetOf(source)
    const blockers: string[] = []
    if (source.lifecycle !== 'active') blockers.push(`This worktree is ${source.lifecycle}.`)
    if (!existsSync(source.cwd)) blockers.push('The worktree\'s folder is gone.')
    blockers.push(...activeIn(source).map((b) => `Worktree: ${b}`), ...activeIn(target).map((b) => `Main checkout: ${b}`))
    const sourceHead = (await out(source.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) ?? ''
    const targetHead = (await out(target.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) ?? ''
    if (!sourceHead) blockers.push('The worktree has no commit to merge.')
    if (!targetHead) blockers.push('The main checkout has no commit to merge into.')
    const sourceBranch = (await out(source.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || undefined
    const targetBranch = (await out(target.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || undefined
    if (!targetBranch) blockers.push('The main checkout is not on a branch (detached HEAD).')
    for (const [w, label] of [[source, 'worktree'], [target, 'main checkout']] as const) {
      const gitDir = await gitDirOf(w.cwd)
      for (const [marker, operation] of IN_PROGRESS) if (gitDir && existsSync(join(gitDir, marker))) blockers.push(`A Git ${operation} is in progress in the ${label}.`)
      const dirty = ((await out(w.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) ?? '').split('\0').filter(Boolean).length
      if (dirty) blockers.push(`The ${label} has uncommitted changes or untracked files. Commit or move them first; Cockpit does not stash.`)
    }
    // The target branch must be checked out in the main checkout only: Git refuses to merge into a branch checked out elsewhere.
    if (targetBranch) {
      const elsewhere = parseWorktreeList((await out(target.cwd, ['worktree', 'list', '--porcelain', '-z'])) ?? '').find((w) => w.branch === targetBranch && w.path !== target.cwd && w.path !== target.canonicalCwd)
      if (elsewhere) blockers.push(`${targetBranch} is also checked out at ${elsewhere.path}.`)
    }
    let mode: MergeMode = 'merge'
    let commits = 0
    let files: Array<{ status: string; path: string }> = []
    if (sourceHead && targetHead) {
      commits = Number(await out(target.cwd, ['rev-list', '--count', `${targetHead}..${sourceHead}`]) ?? '0')
      const sourceHasTarget = await run(target.cwd, ['merge-base', '--is-ancestor', targetHead, sourceHead]).then(() => true, () => false)
      mode = commits === 0 ? 'up-to-date' : sourceHasTarget ? 'fast-forward' : 'merge'
      const diff = (await out(target.cwd, ['diff', '--name-status', '-z', `${targetHead}...${sourceHead}`])) ?? ''
      const fields = diff.split('\0').filter(Boolean)
      for (let i = 0; i < fields.length; i++) {
        const status = fields[i] ?? ''
        if (/^[RC]/.test(status)) { files.push({ status: status[0]!, path: `${fields[i + 1]} → ${fields[i + 2]}` }); i += 2 } else { files.push({ status, path: fields[i + 1] ?? '' }); i += 1 }
      }
      files = files.slice(0, 500)
    }
    const identity = mode === 'merge' && !(await out(target.cwd, ['var', 'GIT_COMMITTER_IDENT']))
      ? 'Git has no name and email for commits in this repository. Set them with git config user.name and user.email (Cockpit does not change them).'
      : undefined
    const open = await openFor(sourceId)
    if (open) blockers.push('A merge of this worktree is waiting: continue or abort it first.')
    const fingerprint = createHash('sha256').update(JSON.stringify([sourceHead, targetHead, targetBranch ?? '', sourceBranch ?? ''])).digest('hex').slice(0, 32)
    return {
      sourceWorkspaceId: source.id, targetWorkspaceId: target.id, ...(sourceBranch ? { sourceBranch } : {}), sourceHead, ...(targetBranch ? { targetBranch } : {}), targetHead,
      ...(source.createdFromBranch && source.createdFromBranch !== targetBranch ? { createdFromBranch: source.createdFromBranch } : {}),
      mode, commits, files, blockers, ...(identity ? { identity } : {}), fingerprint, ...(open ? { open: view(open) } : {}),
    }
  }

  return {
    preflight,

    async merge(sourceId, fingerprint) {
      const source = sourceOf(sourceId)
      const target = targetOf(source)
      return withRepoLock(target.gitCommonDir ?? target.cwd, async () => {
        // Checked again under the lock, immediately before Git starts: approve one state, merge only that state.
        const now = await preflight(sourceId)
        if (now.fingerprint !== fingerprint) refuse({ code: 'stale', detail: 'The branches changed after you checked. Check again before merging.' })
        if (now.blockers.length) refuse({ code: 'blocked', blockers: now.blockers })
        if (now.mode === 'up-to-date') refuse({ code: 'up-to-date' })
        if (now.identity) refuse({ code: 'identity', detail: now.identity })
        const mode: Operation['mode'] = now.mode === 'fast-forward' ? 'fast-forward' : 'merge'
        const at = new Date().toISOString()
        let operation = save({
          id: randomUUID(), repo: target.gitCommonDir ?? target.cwd, sourceWorkspaceId: source.id, targetWorkspaceId: target.id, targetCwd: target.cwd,
          ...(now.sourceBranch ? { sourceBranch: now.sourceBranch } : {}), sourceHead: now.sourceHead, ...(now.targetBranch ? { targetBranch: now.targetBranch } : {}),
          targetHeadBefore: now.targetHead, mode, stage: 'started', conflicts: [], createdAt: at, updatedAt: at,
        })
        options.beforeMerge?.()
        const message = `Merge ${now.sourceBranch ?? now.sourceHead.slice(0, 7)} into ${now.targetBranch ?? 'the main checkout'}`
        const args = mode === 'fast-forward' ? ['merge', '--ff-only', now.sourceHead] : ['merge', '--no-ff', '--no-edit', '-m', message, now.sourceHead]
        try {
          await run(target.cwd, args, MERGE_TIMEOUT_MS)
        } catch (error) {
          const conflicts = await unmerged(target.cwd)
          if (conflicts.length) return view(advance(operation, { stage: 'conflict', conflicts }))
          operation = await settle(operation)
          if (operation.stage === 'merged' || operation.stage === 'conflict') return view(operation)
          return view(advance(operation, { stage: 'failed', error: (error as Error).message }))
        }
        const head = (await out(target.cwd, ['rev-parse', 'HEAD'])) ?? ''
        return view(advance(operation, { stage: 'merged', resultHead: head }))
      })
    },

    async continue(operationId) {
      const recorded = load(operationId) ?? refuse({ code: 'unknown-operation' })
      return withRepoLock(recorded.repo, async () => {
        const operation = await settle(recorded)
        if (operation.stage !== 'conflict') refuse({ code: 'not-in-conflict', stage: operation.stage })
        const gitDir = await gitDirOf(operation.targetCwd)
        const mergeHead = gitDir && existsSync(join(gitDir, 'MERGE_HEAD')) ? readFileSync(join(gitDir, 'MERGE_HEAD'), 'utf8').trim() : undefined
        if (mergeHead !== operation.sourceHead) refuse({ code: 'unsafe', detail: 'The main checkout is no longer in this merge. Check it in a terminal (git status) before doing anything else.' })
        const still = await unmerged(operation.targetCwd)
        if (still.length) refuse({ code: 'still-conflicted', paths: still })
        if (!(await out(operation.targetCwd, ['var', 'GIT_COMMITTER_IDENT']))) refuse({ code: 'identity', detail: 'Git has no name and email for commits in this repository. Set them with git config user.name and user.email (Cockpit does not change them).' })
        try {
          await run(operation.targetCwd, ['commit', '--no-edit'], MERGE_TIMEOUT_MS)
        } catch (error) {
          refuse({ code: 'git-failed', detail: (error as Error).message })
        }
        return view(advance(operation, { stage: 'merged', conflicts: [], resultHead: (await out(operation.targetCwd, ['rev-parse', 'HEAD'])) ?? '' }))
      })
    },

    async abort(operationId) {
      const recorded = load(operationId) ?? refuse({ code: 'unknown-operation' })
      return withRepoLock(recorded.repo, async () => {
        const operation = await settle(recorded)
        if (operation.stage !== 'conflict') refuse({ code: 'not-in-conflict', stage: operation.stage })
        const gitDir = await gitDirOf(operation.targetCwd)
        const mergeHead = gitDir && existsSync(join(gitDir, 'MERGE_HEAD')) ? readFileSync(join(gitDir, 'MERGE_HEAD'), 'utf8').trim() : undefined
        const head = await out(operation.targetCwd, ['rev-parse', 'HEAD'])
        // Only this recorded merge, only while the repository still matches it.
        if (mergeHead !== operation.sourceHead || head !== operation.targetHeadBefore) {
          refuse({ code: 'unsafe', detail: 'The main checkout no longer matches this merge, so Cockpit leaves its files as they are. In a terminal: git status, then git merge --abort if it is still the same merge.' })
        }
        try {
          await run(operation.targetCwd, ['merge', '--abort'], MERGE_TIMEOUT_MS)
        } catch (error) {
          refuse({ code: 'git-failed', detail: (error as Error).message })
        }
        return view(advance(operation, { stage: 'aborted', conflicts: [] }))
      })
    },
  }
}
