import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { StoreReadError } from '../state/read-error.ts'

// <root>/workspaces.json: the opaque identity of every project folder and its workspaces (G-IDENTITY).
// A separate file so projects.json keeps the shape older Cockpits read and write; migration only
// ever adds records here, keyed by the folder's canonical path, never by its display name.
// Version 2 adds worktree workspaces (M1). The file stays version 1 until the first worktree is
// registered, so an older Cockpit keeps reading it for as long as nobody has made one.

export const WORKSPACES_SCHEMA_VERSION = 2
const PRIMARY_ONLY_VERSION = 1

const projectIdentitySchema = z.object({
  id: z.uuid(),
  /** The path the folder was first known by. */
  path: z.string().min(1),
  canonicalPath: z.string().min(1),
  createdAt: z.string(),
})
export type ProjectIdentity = z.output<typeof projectIdentitySchema>

const workspaceSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  /** Every project has exactly one primary workspace; worktrees (G-WORKTREES) are Git linked worktrees of it. */
  kind: z.enum(['primary', 'worktree']),
  cwd: z.string().min(1),
  canonicalCwd: z.string().min(1),
  /** The repository's shared .git folder, or null outside Git. */
  gitCommonDir: z.string().nullable(),
  managed: z.boolean(),
  lifecycle: z.enum(['active', 'archived', 'removed']),
  revision: z.number().int().min(1),
  createdAt: z.string(),
  /** Worktrees only: the name the person gave it, its branch, and the committed state it started from. */
  name: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  /** The workspace it was created from, and that workspace's branch then (the default merge target). */
  createdFrom: z.uuid().optional(),
  createdFromBranch: z.string().min(1).optional(),
  /** Worktrees that stopped being active (W12.4): when, why, and where its work was (the recovery metadata). */
  ended: z.object({
    at: z.string(), reason: z.string().max(500), path: z.string(), branch: z.string().optional(), head: z.string().optional(),
  }).optional(),
})
export type Workspace = z.output<typeof workspaceSchema>
export type WorkspaceEnd = NonNullable<Workspace['ended']>

const fileSchema = z.object({
  schemaVersion: z.union([z.literal(PRIMARY_ONLY_VERSION), z.literal(WORKSPACES_SCHEMA_VERSION)]),
  revision: z.number().int().min(0),
  projects: z.array(projectIdentitySchema),
  workspaces: z.array(workspaceSchema),
})
type WorkspaceFile = z.output<typeof fileSchema>

export interface WorkspaceStore {
  /** Registers a project and primary workspace for every absolute folder not yet known. Idempotent. */
  ensure(paths: readonly string[]): void
  primaryFor(path: string): { project: ProjectIdentity; workspace: Workspace } | undefined
  get(workspaceId: string): Workspace | undefined
  list(): { revision: number; projects: ProjectIdentity[]; workspaces: Workspace[] }
  /** The project's workspaces, primary first. */
  forProject(projectId: string): Workspace[]
  /** Registers a worktree of a known project once; a second call for the same folder returns the first record. */
  addWorktree(input: NewWorktree): Workspace
  /**
   * A worktree's lifecycle: `archived` keeps its folder exactly as it is, `removed` after Git removed it,
   * `active` restores an archived one. The primary never changes. Returns the updated record.
   */
  setLifecycle(workspaceId: string, lifecycle: Workspace['lifecycle'], ended?: WorkspaceEnd): Workspace
}

export interface NewWorktree {
  readonly projectId: string
  readonly cwd: string
  readonly name: string
  readonly branch: string
  readonly baseRef: string
  readonly baseCommit: string
  readonly createdFrom: string
  readonly createdFromBranch?: string
}

/** The folder as the file system names it, so a symlink and its target are one project. */
export function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

/** The repository's shared .git folder for `cwd` (a linked worktree resolves to its main repo), or null. */
export function gitCommonDir(cwd: string): string | null {
  for (let dir = canonicalPath(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return canonicalPath(dotGit)
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      if (!pointer) return null
      const gitDir = resolve(dir, pointer)
      const common = join(gitDir, 'commondir')
      return canonicalPath(existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir)
    }
    if (dirname(dir) === dir) return null
  }
}

const EMPTY: WorkspaceFile = { schemaVersion: PRIMARY_ONLY_VERSION, revision: 0, projects: [], workspaces: [] }

/** The oldest version that can hold these records, so a primary-only file stays readable by older Cockpits. */
const versionFor = (workspaces: readonly Workspace[]): WorkspaceFile['schemaVersion'] =>
  workspaces.some((w) => w.kind !== 'primary') ? WORKSPACES_SCHEMA_VERSION : PRIMARY_ONLY_VERSION

export function createWorkspaceStore(root: string): WorkspaceStore {
  const file = join(root, 'workspaces.json')

  const read = (): WorkspaceFile => {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
      throw new StoreReadError('UNREADABLE', file, (error as Error).message)
    }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new StoreReadError('UNREADABLE', file, 'not valid JSON') }
    const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion
    if (typeof version === 'number' && version > WORKSPACES_SCHEMA_VERSION) throw new StoreReadError('FUTURE_VERSION', file)
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) throw new StoreReadError('UNREADABLE', file, 'unexpected format')
    return parsed.data
  }
  const write = (next: WorkspaceFile): void => {
    // A file that already says 2 stays 2: a reader that understood it once keeps understanding it.
    const schemaVersion = next.schemaVersion === WORKSPACES_SCHEMA_VERSION ? next.schemaVersion : versionFor(next.workspaces)
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...next, schemaVersion }, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const primaryIn = (data: WorkspaceFile, path: string) => {
    const canonical = canonicalPath(path)
    const project = data.projects.find((p) => p.canonicalPath === canonical)
    const workspace = project && data.workspaces.find((w) => w.projectId === project.id && w.kind === 'primary')
    return project && workspace ? { project, workspace } : undefined
  }

  return {
    ensure(paths) {
      const data = read()
      const projects = [...data.projects]
      const workspaces = [...data.workspaces]
      const now = new Date().toISOString()
      for (const path of paths) {
        if (!isAbsolute(path)) continue
        const canonical = canonicalPath(path)
        if (projects.some((p) => p.canonicalPath === canonical)) continue
        // A worktree Cockpit registered is a workspace of its project, not a project of its own.
        if (workspaces.some((w) => w.kind === 'worktree' && w.canonicalCwd === canonical)) continue
        const project: ProjectIdentity = { id: randomUUID(), path, canonicalPath: canonical, createdAt: now }
        projects.push(project)
        workspaces.push({ id: randomUUID(), projectId: project.id, kind: 'primary', cwd: path, canonicalCwd: canonical,
          gitCommonDir: gitCommonDir(canonical), managed: false, lifecycle: 'active', revision: 1, createdAt: now })
      }
      if (projects.length === data.projects.length) return
      write({ ...data, revision: data.revision + 1, projects, workspaces })
    },
    primaryFor: (path) => primaryIn(read(), path),
    get: (workspaceId) => read().workspaces.find((w) => w.id === workspaceId),
    list() {
      const { revision, projects, workspaces } = read()
      return { revision, projects, workspaces }
    },
    forProject(projectId) {
      const mine = read().workspaces.filter((w) => w.projectId === projectId)
      return [...mine.filter((w) => w.kind === 'primary'), ...mine.filter((w) => w.kind !== 'primary')]
    },
    addWorktree(input) {
      const data = read()
      if (!data.projects.some((p) => p.id === input.projectId)) throw new Error('Unknown project')
      const canonical = canonicalPath(input.cwd)
      const existing = data.workspaces.find((w) => w.canonicalCwd === canonical)
      if (existing) {
        if (existing.projectId !== input.projectId || existing.kind !== 'worktree') throw new Error('That folder is already registered as another workspace')
        return existing
      }
      const workspace: Workspace = {
        id: randomUUID(), projectId: input.projectId, kind: 'worktree', cwd: input.cwd, canonicalCwd: canonical,
        gitCommonDir: gitCommonDir(canonical), managed: true, lifecycle: 'active', revision: 1, createdAt: new Date().toISOString(),
        name: input.name, branch: input.branch, baseRef: input.baseRef, baseCommit: input.baseCommit, createdFrom: input.createdFrom,
        ...(input.createdFromBranch ? { createdFromBranch: input.createdFromBranch } : {}),
      }
      write({ ...data, revision: data.revision + 1, workspaces: [...data.workspaces, workspace] })
      return workspace
    },
    setLifecycle(workspaceId, lifecycle, ended) {
      const data = read()
      const current = data.workspaces.find((w) => w.id === workspaceId)
      if (!current) throw new Error('Unknown workspace')
      if (current.kind !== 'worktree') throw new Error('The main checkout is always active')
      const { ended: _previous, ...rest } = current
      const next: Workspace = { ...rest, lifecycle, revision: current.revision + 1, ...(lifecycle !== 'active' && ended ? { ended } : {}) }
      write({ ...data, revision: data.revision + 1, workspaces: data.workspaces.map((w) => (w.id === workspaceId ? next : w)) })
      return next
    },
  }
}
