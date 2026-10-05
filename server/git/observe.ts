import { createHash } from 'node:crypto'
import { listChanges, parseStatusV2, readWorktreeFile, type ChangeStatus } from './changes.ts'
import { run } from './branches.ts'

// A bounded snapshot of a workspace's uncommitted state, taken before and after a run (W7-05).
// Each dirty path gets a content fingerprint, so "changed again during the run" is told apart from
// "was already changed". Sampled twice: anything that moved while it was being read makes the
// snapshot unstable, and attribution from it uncertain.

export const MAX_OBSERVED_PATHS = 2000
/** Files hashed per observation, in total; the rest are fingerprinted by size and modification time. */
export const MAX_HASHED_BYTES = 32 * 1024 * 1024
const MAX_HASHED_FILE = 1024 * 1024

export interface ObservedFile {
  readonly path: string
  readonly oldPath?: string
  readonly status: ChangeStatus
  /** sha256 of the bytes; "link:<target>", "missing", or "stat:<size>:<mtime>" for a file too large to hash. */
  readonly fingerprint: string
}

export interface Observation {
  readonly repo: boolean
  readonly observedAt: string
  readonly head: string | null
  readonly branch: string | null
  readonly files: readonly ObservedFile[]
  /** More dirty paths than MAX_OBSERVED_PATHS: the rest are not compared. */
  readonly truncated: boolean
  /** The status, HEAD or a fingerprint changed while it was being read. */
  readonly stable: boolean
}

export function fingerprint(workspace: string, path: string, limit = MAX_HASHED_FILE): string {
  return print(workspace, path, limit).fingerprint
}

function print(workspace: string, path: string, limit: number): { fingerprint: string; hashed: number } {
  const read = readWorktreeFile(workspace, path, limit)
  switch (read.kind) {
    case 'file': return { fingerprint: createHash('sha256').update(read.bytes).digest('hex'), hashed: read.bytes.length }
    case 'symlink': return { fingerprint: `link:${read.target}`, hashed: 0 }
    case 'too-large': return { fingerprint: `stat:${read.size}:${Math.round(read.mtimeMs)}`, hashed: 0 }
    case 'outside': return { fingerprint: 'outside', hashed: 0 }
    case 'other': return { fingerprint: 'other', hashed: 0 }
    default: return { fingerprint: 'missing', hashed: 0 }
  }
}

async function sample(workspace: string): Promise<Observation> {
  const changes = await listChanges(workspace)
  if (!changes.repo) return { repo: false, observedAt: changes.observedAt, head: null, branch: null, files: [], truncated: false, stable: true }
  // listChanges shows MAX_PATHS; an observation compares up to MAX_OBSERVED_PATHS.
  const all = changes.truncated ? await allPaths(workspace) : changes.files
  let budget = MAX_HASHED_BYTES
  const files = all.slice(0, MAX_OBSERVED_PATHS).map((f): ObservedFile => {
    const { fingerprint, hashed } = print(workspace, f.path, Math.min(MAX_HASHED_FILE, budget))
    budget -= hashed
    return { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, fingerprint }
  })
  return { repo: true, observedAt: changes.observedAt, head: changes.head, branch: changes.branch, files, truncated: all.length > files.length, stable: true }
}

/** Every dirty path, past the summary's bound (paths and status only). */
async function allPaths(workspace: string): Promise<Array<{ path: string; oldPath?: string; status: ChangeStatus }>> {
  const prefix = (await run(workspace, ['rev-parse', '--show-prefix'])).stdout.trim()
  const { stdout } = await run(workspace, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'], undefined, 16_000_000)
  return parseStatusV2(stdout).entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), ...(e.oldPath ? { oldPath: e.oldPath.slice(prefix.length) } : {}), status: e.status }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const same = (a: Observation, b: Observation): boolean =>
  a.head === b.head && a.branch === b.branch && a.files.length === b.files.length &&
  a.files.every((f, i) => f.path === b.files[i]!.path && f.status === b.files[i]!.status && f.fingerprint === b.files[i]!.fingerprint)

export async function observe(workspace: string): Promise<Observation> {
  const first = await sample(workspace)
  if (!first.repo) return first
  const second = await sample(workspace)
  return { ...second, stable: same(first, second) }
}

export type RunFileChange =
  /** Clean before the run, changed after it. */
  | 'changed'
  /** Already changed before the run, and different after it. */
  | 'changed-again'
  /** Changed before the run, clean after it: reverted or committed. */
  | 'cleaned'
  /** Already changed before the run and identical after it. */
  | 'unchanged'

export interface RunComparison {
  readonly files: ReadonlyArray<{ readonly path: string; readonly oldPath?: string; readonly status?: ChangeStatus; readonly change: RunFileChange }>
  readonly headMoved: boolean
  readonly branchMoved: boolean
  /** Why "during this run" cannot be read as exact: each reason is shown. */
  readonly uncertain: readonly string[]
}

/** What differs between a run's two observations. Never says who made a change. */
export function compareObservations(before: Observation, after: Observation): RunComparison {
  const was = new Map(before.files.map((f) => [f.path, f]))
  const now = new Map(after.files.map((f) => [f.path, f]))
  const files: Array<RunComparison['files'][number]> = []
  for (const f of after.files) {
    const earlier = was.get(f.path)
    const change: RunFileChange = !earlier ? 'changed' : earlier.fingerprint === f.fingerprint && earlier.status === f.status ? 'unchanged' : 'changed-again'
    files.push({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, change })
  }
  for (const f of before.files) if (!now.has(f.path)) files.push({ path: f.path, change: 'cleaned' })
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const uncertain: string[] = []
  if (!before.stable || !after.stable) uncertain.push('Files were changing while Cockpit read them.')
  if (before.truncated || after.truncated) uncertain.push(`More than ${MAX_OBSERVED_PATHS} changed paths; the rest were not compared.`)
  if (before.head !== after.head) uncertain.push('A commit was made or checked out during the run; committed changes are not listed file by file.')
  if (before.branch !== after.branch) uncertain.push('The branch changed during the run.')
  return { files, headMoved: before.head !== after.head, branchMoved: before.branch !== after.branch, uncertain }
}
