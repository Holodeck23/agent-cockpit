import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { run } from '../git/branches.ts'
import { withRepoLock } from './repo-lock.ts'
import { canonicalPath, type Workspace, type WorkspaceStore } from './workspaces.ts'

// Worktree workspaces (M1, W12.2; mechanism from G-WORKTREES). A worktree is a Git linked worktree
// of the project's primary checkout, in a visible sibling folder `<project>-worktree-<id>`, on a new
// branch started from a committed state: uncommitted files in the primary are never copied.
// Creation is journaled (validate → git worktree add → verify what Git reports → register) so a
// crash between Git and registration leaves a record that finds the worktree again. Recovery
// registers only an exact match and never prunes, recreates or deletes anything.

export const DEFAULT_BRANCH_PREFIX = 'codex/'
export const WORKTREE_NAME_MAX = 60
const ADD_TIMEOUT_MS = 120_000

export type WorktreeRefusal =
  | { readonly code: 'unknown-project' }
  | { readonly code: 'not-git' }
  | { readonly code: 'unborn' }
  | { readonly code: 'operation-in-progress'; readonly operation: string }
  | { readonly code: 'conflicted' }
  | { readonly code: 'invalid-name' }
  | { readonly code: 'invalid-ref'; readonly ref: string }
  | { readonly code: 'invalid-branch'; readonly branch: string }
  | { readonly code: 'branch-exists'; readonly branch: string; readonly checkedOutAt?: string }
  | { readonly code: 'name-taken'; readonly workspaceId: string }
  | { readonly code: 'path-exists'; readonly path: string }
  | { readonly code: 'git-failed'; readonly detail: string; readonly operationId: string }
  | { readonly code: 'not-verified'; readonly detail: string; readonly operationId: string }
  | { readonly code: 'unknown-operation' }
  | { readonly code: 'not-recoverable'; readonly detail: string }

export class WorktreeRefusalError extends Error {
  constructor(readonly refusal: WorktreeRefusal) { super(refusal.code) }
}

const refuse = (refusal: WorktreeRefusal): never => { throw new WorktreeRefusalError(refusal) }

export interface Preflight {
  /** Full commit id of the primary's HEAD: the default base. */
  readonly head: string
  readonly branch?: string
  /** Uncommitted files (tracked and untracked) in the primary that a new worktree will NOT contain. */
  readonly uncommitted: number
  readonly branchPrefix: string
}

export interface CreateRequest {
  readonly name: string
  /** A commit-ish; defaults to the primary's HEAD. */
  readonly base?: string
  /** Defaults to `codex/<name as a slug>`; a branch the person types is used as typed. */
  readonly branch?: string
}

const operationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  primaryWorkspaceId: z.uuid(),
  repo: z.string().min(1),
  stage: z.enum(['validated', 'created', 'registered', 'failed', 'dismissed']),
  name: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  path: z.string(),
  createdFromBranch: z.string().optional(),
  workspaceId: z.uuid().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
type Operation = z.output<typeof operationSchema>

/** An interrupted create, as the person is shown it. `recoverable`: Git holds exactly what was asked for. */
export interface PendingOperation {
  readonly id: string
  readonly name: string
  readonly branch: string
  readonly path: string
  readonly state: 'recoverable' | 'mismatch' | 'nothing-created' | 'dismissed'
  readonly detail?: string
}

export interface GitWorktree { readonly path: string; readonly head?: string; readonly branch?: string }

/** `git worktree list --porcelain -z`: NUL-terminated fields, an empty field between entries. */
export function parseWorktreeList(output: string): GitWorktree[] {
  const entries: GitWorktree[] = []
  let current: { path?: string; head?: string; branch?: string } = {}
  const flush = (): void => {
    if (current.path) entries.push({ path: current.path, ...(current.head ? { head: current.head } : {}), ...(current.branch ? { branch: current.branch } : {}) })
    current = {}
  }
  for (const field of output.split('\0')) {
    if (field === '') { flush(); continue }
    if (field.startsWith('worktree ')) { flush(); current.path = field.slice('worktree '.length) }
    else if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length)
  }
  flush()
  return entries
}

export function branchSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return slug || 'worktree'
}

const ok = async (cwd: string, args: readonly string[]): Promise<boolean> => {
  try { await run(cwd, args); return true } catch { return false }
}
const out = async (cwd: string, args: readonly string[]): Promise<string | undefined> => {
  try { return (await run(cwd, args)).stdout.trim() } catch { return undefined }
}

const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
]

export interface WorktreeServiceOptions {
  /** Test seam: runs after Git created and verified the worktree, before it is registered. */
  readonly beforeRegister?: () => void
}

export interface WorktreeService {
  preflight(projectId: string): Promise<Preflight>
  create(projectId: string, request: CreateRequest): Promise<Workspace>
  /** Creates that stopped before registration, and what Git holds for each. */
  pending(projectId: string): Promise<PendingOperation[]>
  /** Registers an interrupted create when Git holds exactly what it asked for. */
  recover(operationId: string): Promise<Workspace>
  /** Forgets an interrupted create; whatever Git holds stays exactly where it is. */
  dismiss(operationId: string): PendingOperation
}

export function createWorktreeService(root: string, workspaces: WorkspaceStore, options: WorktreeServiceOptions = {}): WorktreeService {
  const dir = join(root, 'worktree-operations')

  const save = (operation: Operation): Operation => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${operation.id}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(operation, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    return operation
  }
  const advance = (operation: Operation, change: Partial<Operation>): Operation =>
    save({ ...operation, ...change, updatedAt: new Date().toISOString() })
  const load = (id: string): Operation | undefined => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined
    try { return operationSchema.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))) } catch { return undefined }
  }
  const all = (): Operation[] => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return [] }
    return names.filter((n) => n.endsWith('.json')).flatMap((n) => { const op = load(n.slice(0, -5)); return op ? [op] : [] })
  }

  const primaryOf = (projectId: string): Workspace =>
    workspaces.forProject(projectId).find((w) => w.kind === 'primary') ?? refuse({ code: 'unknown-project' })
  const repoOf = (primary: Workspace): string => primary.gitCommonDir ?? refuse({ code: 'not-git' })

  const listWorktrees = async (cwd: string): Promise<GitWorktree[]> =>
    parseWorktreeList((await run(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout)

  /** Git's view of an operation's folder: exactly what was asked, something else, or nothing. */
  const inspect = async (operation: Operation, cwd: string): Promise<PendingOperation> => {
    const base = { id: operation.id, name: operation.name, branch: operation.branch, path: operation.path }
    const canonical = canonicalPath(operation.path)
    const found = (await listWorktrees(cwd)).find((w) => canonicalPath(w.path) === canonical)
    if (found) {
      if (found.branch === operation.branch && found.head === operation.baseCommit) return { ...base, state: 'recoverable' }
      return { ...base, state: 'mismatch', detail: `Git has a worktree there on ${found.branch ?? 'a detached HEAD'} at ${found.head?.slice(0, 7) ?? 'no commit'}` }
    }
    const branchExists = await ok(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${operation.branch}`])
    const folderExists = existsSync(operation.path)
    if (branchExists || folderExists) {
      const detail = [branchExists ? `branch ${operation.branch} exists` : '', folderExists ? 'the folder exists but Git does not list it as a worktree' : ''].filter(Boolean).join('; ')
      return { ...base, state: 'mismatch', detail }
    }
    return { ...base, state: 'nothing-created' }
  }

  const register = (operation: Operation): Workspace => {
    const workspace = workspaces.addWorktree({
      projectId: operation.projectId, cwd: operation.path, name: operation.name, branch: operation.branch,
      baseRef: operation.baseRef, baseCommit: operation.baseCommit, createdFrom: operation.primaryWorkspaceId,
      ...(operation.createdFromBranch ? { createdFromBranch: operation.createdFromBranch } : {}),
    })
    advance(operation, { stage: 'registered', workspaceId: workspace.id })
    return workspace
  }

  const validateRepository = async (cwd: string): Promise<void> => {
    if (!(await ok(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))) refuse({ code: 'unborn' })
    const gitDir = await out(cwd, ['rev-parse', '--absolute-git-dir'])
    for (const [marker, operation] of IN_PROGRESS) if (gitDir && existsSync(join(gitDir, marker))) refuse({ code: 'operation-in-progress', operation })
    if ((await out(cwd, ['ls-files', '--unmerged'])) !== '') refuse({ code: 'conflicted' })
  }

  return {
    async preflight(projectId) {
      const primary = primaryOf(projectId)
      repoOf(primary)
      await validateRepository(primary.cwd)
      const head = (await out(primary.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])) ?? refuse({ code: 'unborn' })
      const branch = await out(primary.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      const fields = ((await out(primary.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) ?? '').split('\0').filter(Boolean)
      // In -z output a rename or copy carries its old path as the next field: count entries, not fields.
      let uncommitted = 0
      for (let i = 0; i < fields.length; i++) { uncommitted++; if (/^[RC]/.test(fields[i] ?? '')) i++ }
      return { head, ...(branch ? { branch } : {}), uncommitted, branchPrefix: DEFAULT_BRANCH_PREFIX }
    },

    async create(projectId, request) {
      const primary = primaryOf(projectId)
      const repo = repoOf(primary)
      return withRepoLock(repo, async () => {
        const cwd = primary.cwd
        await validateRepository(cwd)
        const name = request.name.trim()
        if (!name || name.length > WORKTREE_NAME_MAX || /[\u0000-\u001f]/.test(name)) refuse({ code: 'invalid-name' })
        const taken = workspaces.forProject(projectId).find((w) => w.kind === 'worktree' && w.lifecycle === 'active' && w.name === name)
        if (taken) refuse({ code: 'name-taken', workspaceId: taken.id })

        const baseRef = request.base?.trim() || 'HEAD'
        const baseCommit = (await out(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`])) || refuse({ code: 'invalid-ref', ref: baseRef })

        const branch = request.branch?.trim() || `${DEFAULT_BRANCH_PREFIX}${branchSlug(name)}`
        if (branch.startsWith('-') || !(await ok(cwd, ['check-ref-format', '--branch', branch]))) refuse({ code: 'invalid-branch', branch })
        if (await ok(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
          const at = (await listWorktrees(cwd)).find((w) => w.branch === branch)?.path
          refuse({ code: 'branch-exists', branch, ...(at ? { checkedOutAt: at } : {}) })
        }

        let path = ''
        for (let attempt = 0; attempt < 5 && !path; attempt++) {
          const candidate = `${primary.canonicalCwd}-worktree-${randomBytes(3).toString('hex')}`
          if (!existsSync(candidate)) path = candidate
        }
        if (!path) refuse({ code: 'path-exists', path: `${primary.canonicalCwd}-worktree-…` })

        const createdFromBranch = await out(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
        const now = new Date().toISOString()
        let operation = save({
          id: randomUUID(), projectId, primaryWorkspaceId: primary.id, repo, stage: 'validated', name, branch, baseRef,
          baseCommit, path, ...(createdFromBranch ? { createdFromBranch } : {}), createdAt: now, updatedAt: now,
        })

        try {
          await run(cwd, ['worktree', 'add', '-b', branch, '--', path, baseCommit], ADD_TIMEOUT_MS)
        } catch (error) {
          const detail = (error as Error).message
          // Git can fail after creating the branch or the folder; keep the record so it is found again.
          const seen = await inspect(operation, cwd).catch(() => undefined)
          operation = advance(operation, { stage: seen && seen.state !== 'nothing-created' ? 'created' : 'failed', error: detail })
          return refuse({ code: 'git-failed', detail, operationId: operation.id })
        }
        operation = advance(operation, { stage: 'created' })

        const seen = await inspect(operation, cwd)
        if (seen.state !== 'recoverable') return refuse({ code: 'not-verified', detail: seen.detail ?? 'Git does not list the new worktree', operationId: operation.id })
        options.beforeRegister?.()
        return register(operation)
      })
    },

    async pending(projectId) {
      const primary = primaryOf(projectId)
      const open = all().filter((op) => op.projectId === projectId && (op.stage === 'validated' || op.stage === 'created'))
      return Promise.all(open.map((op) => inspect(op, primary.cwd)))
    },

    async recover(operationId) {
      const operation = load(operationId) ?? refuse({ code: 'unknown-operation' })
      const registered = operation.stage === 'registered' && operation.workspaceId ? workspaces.get(operation.workspaceId) : undefined
      if (registered) return registered
      if (operation.stage !== 'validated' && operation.stage !== 'created') refuse({ code: 'not-recoverable', detail: `This create is ${operation.stage}` })
      const primary = primaryOf(operation.projectId)
      return withRepoLock(operation.repo, async () => {
        const seen = await inspect(operation, primary.cwd)
        if (seen.state !== 'recoverable') refuse({ code: 'not-recoverable', detail: seen.detail ?? 'Git holds nothing from this create' })
        return register(operation)
      })
    },

    dismiss(operationId) {
      const operation = load(operationId) ?? refuse({ code: 'unknown-operation' })
      if (operation.stage !== 'validated' && operation.stage !== 'created') refuse({ code: 'not-recoverable', detail: `This create is ${operation.stage}` })
      advance(operation, { stage: 'dismissed' })
      return { id: operation.id, name: operation.name, branch: operation.branch, path: operation.path, state: 'dismissed', detail: 'Any folder or branch Git created was left as it is' }
    },
  }
}
