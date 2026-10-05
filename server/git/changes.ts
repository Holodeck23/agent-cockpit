import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { GitError, run } from './branches.ts'

// The workspace's uncommitted changes against HEAD (J4): which files, how many lines, and one
// file's diff at a time. Workspace-wide on purpose: Git cannot say which agent (or person) made a
// change, so nothing here is called "this agent's changes". Paths are relative to the project
// folder, also when it sits inside a larger repository. Machine output is read NUL-delimited, and
// no diff or textconv helper from the repository's config ever runs.

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted'

export interface ChangedFile {
  readonly path: string
  readonly oldPath?: string
  readonly status: ChangeStatus
  /** Something about it is staged (index differs from HEAD). */
  readonly staged: boolean
  /** Something about it is not staged (working tree differs from the index), or it is untracked. */
  readonly unstaged: boolean
  readonly additions?: number
  readonly deletions?: number
  readonly binary?: boolean
  readonly symlink?: boolean
  /** A submodule: its recorded commit moved, and/or its own work tree has changes. */
  readonly submodule?: { readonly commitChanged: boolean; readonly modified: boolean; readonly untracked: boolean }
}

export interface Changes {
  readonly repo: true
  /** Full commit id of HEAD; null in a repository with no commits yet. */
  readonly head: string | null
  /** Null when HEAD is detached. */
  readonly branch: string | null
  /** What the changes are against: HEAD, or an empty tree before the first commit. */
  readonly base: 'head' | 'empty'
  readonly observedAt: string
  /** At most MAX_PATHS, in path order; `total` counts all of them. */
  readonly files: readonly ChangedFile[]
  readonly total: number
  readonly truncated: boolean
  readonly conflicted: number
}

export interface NoRepository {
  readonly repo: false
  readonly observedAt: string
}

export interface DiffLine {
  readonly kind: 'hunk' | 'add' | 'del' | 'ctx'
  readonly text: string
  readonly old?: number
  readonly new?: number
}

export interface FileDiff {
  readonly path: string
  readonly oldPath?: string
  readonly status: ChangeStatus
  readonly base: 'head' | 'empty'
  readonly head: string | null
  readonly observedAt: string
  readonly binary: boolean
  /** The diff stopped at MAX_DIFF_LINES; the rest is not shown. */
  readonly truncated: boolean
  /** Why no text diff is shown, when it isn't. */
  readonly omitted?: 'too-large' | 'binary' | 'symlink' | 'submodule' | 'outside'
  readonly size?: number
  readonly symlinkTarget?: string
  readonly submodule?: { readonly from?: string; readonly to?: string; readonly modified: boolean; readonly untracked: boolean }
  readonly lines: readonly DiffLine[]
}

/** A file as it was at the base revision: the read-only historical view of a left-side line. */
export interface BaseFile {
  readonly path: string
  readonly revision: string
  readonly text?: string
  readonly omitted?: 'too-large' | 'binary' | 'not-in-base'
  readonly size?: number
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const MAX_PATHS = 500
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_DIFF_LINES = 20_000
/** Untracked files read to count their lines, in total per list; past it their counts are left out. */
export const MAX_COUNTED_BYTES = 16 * 1024 * 1024
// `run` disables fsmonitor globally; this additionally disables external diff helpers.
const SAFE = ['-c', 'diff.external=']
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M']

interface StatusEntry {
  readonly path: string
  readonly oldPath?: string
  readonly status: ChangeStatus
  readonly staged: boolean
  readonly unstaged: boolean
  readonly mode?: string
  readonly submodule?: ChangedFile['submodule']
}

export interface StatusV2 {
  readonly head: string | null
  readonly branch: string | null
  readonly entries: readonly StatusEntry[]
}

const statusOf = (x: string, y: string): ChangeStatus => {
  const either = (c: string) => x === c || y === c
  if (either('R')) return 'renamed'
  if (either('C')) return 'copied'
  if (either('T')) return 'typechange'
  if (either('D')) return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

/**
 * `git status --porcelain=v2 --branch -z`. Header lines "# branch.oid <oid>|(initial)" and
 * "# branch.head <name>|(detached)"; "1 XY sub mH mI mW hH hI path"; "2 … Xscore path\0orig";
 * "u XY sub m1 m2 m3 mW h1 h2 h3 path"; "? path". Paths are taken whole, never split on spaces.
 */
export function parseStatusV2(output: string): StatusV2 {
  const parts = output.split('\0')
  let head: string | null = null
  let branch: string | null = null
  const entries: StatusEntry[] = []
  const field = (line: string, count: number): { fields: string[]; rest: string } => {
    const fields: string[] = []
    let at = 0
    for (let i = 0; i < count; i++) {
      const next = line.indexOf(' ', at)
      fields.push(line.slice(at, next))
      at = next + 1
    }
    return { fields, rest: line.slice(at) }
  }
  const submoduleOf = (sub: string): ChangedFile['submodule'] =>
    sub.startsWith('S') ? { commitChanged: sub[1] === 'C', modified: sub[2] === 'M', untracked: sub[3] === 'U' } : undefined
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!
    if (line.startsWith('# branch.oid ')) { const oid = line.slice(13); head = oid === '(initial)' ? null : oid; continue }
    if (line.startsWith('# branch.head ')) { const name = line.slice(14); branch = name === '(detached)' ? null : name; continue }
    const kind = line[0]
    if (kind === '?') { entries.push({ path: line.slice(2), status: 'untracked', staged: false, unstaged: true }); continue }
    if (kind === '1' || kind === '2') {
      const { fields, rest } = field(line, kind === '1' ? 8 : 9)
      const [, xy, sub, , , modeWorktree] = fields as [string, string, string, string, string, string]
      const x = xy[0]!, y = xy[1]!
      const submodule = submoduleOf(sub)
      const entry = { path: rest, status: statusOf(x, y), staged: x !== '.', unstaged: y !== '.', mode: modeWorktree, ...(submodule ? { submodule } : {}) }
      entries.push(kind === '2' ? { ...entry, oldPath: parts[++i]! } : entry)
      continue
    }
    if (kind === 'u') {
      const { fields, rest } = field(line, 10)
      const submodule = submoduleOf(fields[2]!)
      entries.push({ path: rest, status: 'conflicted', staged: true, unstaged: true, mode: fields[6], ...(submodule ? { submodule } : {}) })
    }
  }
  return { head, branch, entries }
}

/** `git diff --numstat -z`: "add\tdel\tpath\0", a rename "add\tdel\t\0old\0new\0", binary as "-\t-". */
export function parseNumstat(output: string): Map<string, { additions: number; deletions: number } | { binary: true }> {
  const parts = output.split('\0')
  const counts = new Map<string, { additions: number; deletions: number } | { binary: true }>()
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]!)
    if (!match) continue
    let path = match[3]!
    if (path === '') { i++; path = parts[++i] ?? '' }
    counts.set(path, match[1] === '-' ? { binary: true } : { additions: Number(match[1]), deletions: Number(match[2]) })
  }
  return counts
}

const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0)

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

/**
 * A working-tree file read without following links and without leaving the workspace: a symlink
 * is reported as one (with its target text), never read through; a path whose real location is
 * outside the workspace is not read at all.
 */
export type WorktreeRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'outside' }
  | { readonly kind: 'other' }
  | { readonly kind: 'too-large'; readonly size: number; readonly mtimeMs: number }
  | { readonly kind: 'file'; readonly bytes: Buffer; readonly binary: boolean }

export function readWorktreeFile(workspace: string, path: string, limit = MAX_FILE_BYTES): WorktreeRead {
  const file = join(workspace, path)
  let stat
  try { stat = lstatSync(file) } catch { return { kind: 'missing' } }
  if (stat.isSymbolicLink()) {
    try { return { kind: 'symlink', target: readlinkSync(file) } } catch { return { kind: 'missing' } }
  }
  if (!stat.isFile()) return { kind: 'other' }
  // A parent folder swapped for a link would put the real file elsewhere.
  try {
    const root = realpathSync(workspace)
    const real = realpathSync(file)
    if (real !== root && !real.startsWith(root + sep)) return { kind: 'outside' }
  } catch { return { kind: 'missing' } }
  let fd: number
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { return { kind: 'missing' } }
  try {
    const size = fstatSync(fd).size
    if (size > limit) return { kind: 'too-large', size, mtimeMs: stat.mtimeMs }
    const bytes = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, bytes, read, size - read, read)
      if (n === 0) break
      read += n
    }
    const kept = bytes.subarray(0, read)
    return { kind: 'file', bytes: kept, binary: isBinary(kept) }
  } finally {
    closeSync(fd)
  }
}

async function status(projectPath: string): Promise<{ prefix: string; state: StatusV2 } | undefined> {
  let prefix: string
  try {
    prefix = (await run(projectPath, ['rev-parse', '--show-prefix'])).stdout.trim()
  } catch {
    return undefined
  }
  const { stdout } = await run(projectPath, [...SAFE, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=none', '--', '.'], undefined, 32_000_000)
  return { prefix, state: parseStatusV2(stdout) }
}

const relative = (prefix: string, path: string): string => (path.startsWith(prefix) ? path.slice(prefix.length) : path)

export async function listChanges(projectPath: string): Promise<Changes | NoRepository> {
  const observedAt = new Date().toISOString()
  const read = await status(projectPath)
  if (!read) return { repo: false, observedAt }
  const { prefix, state } = read
  const base = state.head ? 'HEAD' : EMPTY_TREE
  const numstat = await run(projectPath, [...SAFE, 'diff', base, '--numstat', '-z', ...DIFF_FLAGS, '--relative'], undefined, 8_000_000)
  const counts = parseNumstat(numstat.stdout)
  const all = state.entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ ...e, path: relative(prefix, e.path), ...(e.oldPath ? { oldPath: relative(prefix, e.oldPath) } : {}) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  let budget = MAX_COUNTED_BYTES
  const shown = all.slice(0, MAX_PATHS).map((e): ChangedFile => {
    const { mode, ...entry } = e
    const flags = { ...entry, ...(mode === '120000' ? { symlink: true } : {}) }
    if (e.status === 'untracked') {
      const file = readWorktreeFile(projectPath, e.path, Math.min(MAX_FILE_BYTES, budget))
      if (file.kind === 'file') budget -= file.bytes.length
      if (file.kind === 'symlink') return { ...flags, symlink: true }
      if (file.kind !== 'file') return flags
      return file.binary ? { ...flags, binary: true } : { ...flags, additions: lineCount(file.bytes.toString('utf8')), deletions: 0 }
    }
    const count = counts.get(e.path)
    if (!count || e.submodule) return flags
    return 'binary' in count ? { ...flags, binary: true } : { ...flags, ...count }
  })
  return {
    repo: true, head: state.head, branch: state.branch, base: state.head ? 'head' : 'empty', observedAt,
    files: shown, total: all.length, truncated: all.length > shown.length, conflicted: all.filter((e) => e.status === 'conflicted').length,
  }
}

/** Unified diff text as lines with their old and new line numbers, at most MAX_DIFF_LINES. */
export function parseUnified(text: string, max = MAX_DIFF_LINES): { lines: DiffLine[]; binary: boolean; truncated: boolean } {
  if (/^Binary files .* differ$/m.test(text)) return { lines: [], binary: true, truncated: false }
  const lines: DiffLine[] = []
  let oldLine = 0, newLine = 0, inHunk = false
  for (const raw of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    const counted = hunk || (inHunk && /^[-+ ]/.test(raw))
    if (counted && lines.length >= max) return { lines, binary: false, truncated: true }
    if (hunk) {
      inHunk = true
      oldLine = Number(hunk[1]); newLine = Number(hunk[2])
      lines.push({ kind: 'hunk', text: raw })
    } else if (!inHunk || raw.startsWith('\\')) continue
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1), new: newLine++ })
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1), old: oldLine++ })
    else if (raw.startsWith(' ')) lines.push({ kind: 'ctx', text: raw.slice(1), old: oldLine++, new: newLine++ })
  }
  return { lines, binary: false, truncated: false }
}

/** Size of a blob at the base, or undefined when the path is not there. */
async function baseSize(projectPath: string, path: string): Promise<number | undefined> {
  try { return Number((await run(projectPath, ['cat-file', '-s', `HEAD:./${path}`])).stdout.trim()) } catch { return undefined }
}

/** One changed file's diff. Only a path in the current changes is diffed, never one the caller made up. */
export async function fileDiff(projectPath: string, path: string): Promise<FileDiff> {
  const changes = await listChanges(projectPath)
  if (!changes.repo) throw new GitError('Git changes are unavailable: this folder is not a Git repository')
  const file = changes.files.find((f) => f.path === path)
  if (!file) throw new GitError('That file has not changed since the last commit')
  const common = { path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), status: file.status, base: changes.base, head: changes.head, observedAt: changes.observedAt }
  const none = { ...common, binary: false, truncated: false, lines: [] as DiffLine[] }

  if (file.status === 'untracked') {
    const read = readWorktreeFile(projectPath, path)
    if (read.kind === 'symlink') return { ...none, omitted: 'symlink', symlinkTarget: read.target }
    if (read.kind === 'outside') return { ...none, omitted: 'outside' }
    if (read.kind === 'too-large') return { ...none, omitted: 'too-large', size: read.size }
    if (read.kind !== 'file') throw new GitError('That file changed since the list was read')
    if (read.binary) return { ...none, binary: true, omitted: 'binary', size: read.bytes.length }
    const content = read.bytes.toString('utf8')
    const body = content.endsWith('\n') ? content.slice(0, -1) : content
    const added = body.length === 0 ? [] : body.split('\n')
    const shown = added.slice(0, MAX_DIFF_LINES - 1)
    return { ...common, binary: false, truncated: shown.length < added.length,
      lines: [{ kind: 'hunk', text: `@@ -0,0 +1,${added.length} @@` }, ...shown.map((text, i): DiffLine => ({ kind: 'add', text, new: i + 1 }))] }
  }

  const baseRev = changes.head ? 'HEAD' : EMPTY_TREE
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  if (file.submodule) {
    const { stdout } = await run(projectPath, [...SAFE, 'diff', baseRev, ...DIFF_FLAGS, '--relative', '--submodule=short', '--', ...paths])
    const from = /^-Subproject commit ([0-9a-f]+)/m.exec(stdout)?.[1]
    const to = /^\+Subproject commit ([0-9a-f]+)/m.exec(stdout)?.[1]
    return { ...none, omitted: 'submodule', submodule: { ...(from ? { from } : {}), ...(to ? { to } : {}), modified: file.submodule.modified, untracked: file.submodule.untracked } }
  }
  if (file.binary) return { ...none, binary: true, omitted: 'binary' }
  // Both sides stay within bounds before any text is produced.
  const current = file.status === 'deleted' ? undefined : readWorktreeFile(projectPath, path)
  if (current?.kind === 'too-large') return { ...none, omitted: 'too-large', size: current.size }
  if (current?.kind === 'outside') return { ...none, omitted: 'outside' }
  if (file.symlink && current?.kind === 'symlink') {
    // The link's own text is what changed; its target is never read.
    const { stdout } = await run(projectPath, [...SAFE, 'diff', baseRev, ...DIFF_FLAGS, '--relative', '--', ...paths])
    return { ...common, ...parseUnified(stdout), symlinkTarget: current.target }
  }
  const before = changes.head ? await baseSize(projectPath, file.oldPath ?? path) : undefined
  if (before !== undefined && before > MAX_FILE_BYTES) return { ...none, omitted: 'too-large', size: before }
  const { stdout } = await run(projectPath, [...SAFE, 'diff', baseRev, ...DIFF_FLAGS, '--relative', '--', ...paths], undefined, 8_000_000)
  const parsed = parseUnified(stdout)
  return parsed.binary ? { ...none, binary: true, omitted: 'binary' } : { ...common, ...parsed }
}

/**
 * The base revision's copy of a changed path (its old name for a rename): what a left-side or
 * deleted line refers to. Bounded and text only; never a path outside the current changes.
 */
export async function baseFile(projectPath: string, path: string): Promise<BaseFile> {
  const changes = await listChanges(projectPath)
  if (!changes.repo) throw new GitError('Git changes are unavailable: this folder is not a Git repository')
  const file = changes.files.find((f) => f.path === path || f.oldPath === path)
  if (!file) throw new GitError('That file has not changed since the last commit')
  const at = file.oldPath ?? file.path
  if (!changes.head) return { path: at, revision: 'empty', omitted: 'not-in-base' }
  const size = await baseSize(projectPath, at)
  if (size === undefined) return { path: at, revision: changes.head, omitted: 'not-in-base' }
  if (size > MAX_FILE_BYTES) return { path: at, revision: changes.head, omitted: 'too-large', size }
  const { stdout } = await run(projectPath, ['cat-file', 'blob', `${changes.head}:./${at}`], undefined, MAX_FILE_BYTES * 2, 'buffer')
  const bytes = stdout as unknown as Buffer
  if (isBinary(bytes)) return { path: at, revision: changes.head, omitted: 'binary', size }
  return { path: at, revision: changes.head, text: bytes.toString('utf8') }
}
