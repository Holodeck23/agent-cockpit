import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { StoreReadError } from '../state/read-error.ts'

// <root>/workspaces.json: the opaque identity of every project folder and its workspaces (G-IDENTITY).
// A separate file so projects.json keeps the shape older Cockpits read and write; migration only
// ever adds records here, keyed by the folder's canonical path, never by its display name.

export const WORKSPACES_SCHEMA_VERSION = 1

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
  /** Worktrees arrive with G-WORKTREES; every project has exactly one primary workspace. */
  kind: z.enum(['primary']),
  cwd: z.string().min(1),
  canonicalCwd: z.string().min(1),
  /** The repository's shared .git folder, or null outside Git. */
  gitCommonDir: z.string().nullable(),
  managed: z.boolean(),
  lifecycle: z.enum(['active']),
  revision: z.number().int().min(1),
  createdAt: z.string(),
})
export type Workspace = z.output<typeof workspaceSchema>

const fileSchema = z.object({
  schemaVersion: z.literal(WORKSPACES_SCHEMA_VERSION),
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

const EMPTY: WorkspaceFile = { schemaVersion: WORKSPACES_SCHEMA_VERSION, revision: 0, projects: [], workspaces: [] }

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
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 })
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
  }
}
