import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GitError, run } from './branches.ts'

// The project's uncommitted changes against HEAD (J4): which files, how many lines, and each
// file's diff. Project-wide on purpose: Git cannot say which agent (or person) made a change.
// Paths are relative to the project folder, also when it sits inside a larger repository.

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface ChangedFile {
  readonly path: string
  readonly oldPath?: string
  readonly status: ChangeStatus
  readonly additions?: number
  readonly deletions?: number
  readonly binary?: boolean
}

export interface Changes {
  readonly repo: boolean
  readonly files: readonly ChangedFile[]
}

export interface DiffLine {
  readonly kind: 'hunk' | 'add' | 'del' | 'ctx'
  readonly text: string
  readonly old?: number
  readonly new?: number
}

export interface FileDiff {
  readonly path: string
  readonly binary: boolean
  /** The diff was cut at MAX_DIFF_LINES. */
  readonly truncated: boolean
  readonly lines: readonly DiffLine[]
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_DIFF_LINES = 5000
const MAX_UNTRACKED_BYTES = 512 * 1024

/** `git status --porcelain=v1 -z`: "XY path\0", and for a rename "XY new\0old\0". */
export function parsePorcelain(output: string): ChangedFile[] {
  const parts = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const x = entry[0]!, y = entry[1]!
    const path = entry.slice(3)
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      files.push({ path, oldPath: parts[++i]!, status: 'renamed' })
    } else if (x === '?' && y === '?') files.push({ path, status: 'untracked' })
    else if (x === 'D' || y === 'D') files.push({ path, status: 'deleted' })
    else if (x === 'A') files.push({ path, status: 'added' })
    else if (x !== '!') files.push({ path, status: 'modified' })
  }
  return files
}

/** `git diff --numstat -z`: "add\tdel\tpath\0", a rename "add\tdel\t\0old\0new\0", binary as "-\t-". */
export function parseNumstat(output: string): Map<string, { additions: number; deletions: number } | { binary: true }> {
  const parts = output.split('\0')
  const counts = new Map<string, { additions: number; deletions: number } | { binary: true }>()
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]!)
    if (!match) continue
    let path = match[3]!
    if (path === '') { i++; path = parts[++i] ?? '' }
    counts.set(path, match[1] === '-' ? { binary: true } : { additions: Number(match[1]), deletions: Number(match[2]) })
  }
  return counts
}

const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0)

function readUntracked(projectPath: string, path: string): { bytes?: Buffer; binary: boolean; tooLarge: boolean } {
  const file = join(projectPath, path)
  const size = statSync(file).size
  if (size > MAX_UNTRACKED_BYTES) return { binary: false, tooLarge: true }
  const bytes = readFileSync(file)
  return { bytes, binary: isBinary(bytes), tooLarge: false }
}

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

export async function listChanges(projectPath: string): Promise<Changes> {
  let prefix: string
  try {
    prefix = (await run(projectPath, ['rev-parse', '--show-prefix'])).stdout.trim()
  } catch {
    return { repo: false, files: [] }
  }
  const head = await run(projectPath, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => 'HEAD', () => EMPTY_TREE)
  const [status, numstat] = await Promise.all([
    run(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    run(projectPath, ['diff', head, '--numstat', '-z', '-M', '--relative']),
  ])
  const counts = parseNumstat(numstat.stdout)
  const files = parsePorcelain(status.stdout)
    .filter((f) => f.path.startsWith(prefix))
    .map((f): ChangedFile => {
      const path = f.path.slice(prefix.length)
      const oldPath = f.oldPath?.startsWith(prefix) ? f.oldPath.slice(prefix.length) : f.oldPath
      const base = { path, ...(oldPath ? { oldPath } : {}), status: f.status }
      if (f.status === 'untracked') {
        try {
          const read = readUntracked(projectPath, path)
          if (read.binary) return { ...base, binary: true }
          return read.bytes ? { ...base, additions: lineCount(read.bytes.toString('utf8')), deletions: 0 } : base
        } catch { return base }
      }
      const count = counts.get(path)
      if (!count) return base
      return 'binary' in count ? { ...base, binary: true } : { ...base, ...count }
    })
  return { repo: true, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

/** Unified diff text as lines with their old and new line numbers. */
export function parseUnified(text: string): { lines: DiffLine[]; binary: boolean; truncated: boolean } {
  if (/^Binary files .* differ$/m.test(text)) return { lines: [], binary: true, truncated: false }
  const lines: DiffLine[] = []
  let oldLine = 0, newLine = 0, inHunk = false
  for (const raw of text.split('\n')) {
    if (lines.length >= MAX_DIFF_LINES) return { lines, binary: false, truncated: true }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
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

/** One changed file's diff. Only a path in the current changes is diffed, never one the caller made up. */
export async function fileDiff(projectPath: string, path: string): Promise<FileDiff> {
  const { files } = await listChanges(projectPath)
  const file = files.find((f) => f.path === path)
  if (!file) throw new GitError('That file has not changed since the last commit')
  if (file.status === 'untracked') {
    const read = readUntracked(projectPath, path)
    if (read.binary) return { path, binary: true, truncated: false, lines: [] }
    if (!read.bytes) return { path, binary: false, truncated: true, lines: [] }
    const content = read.bytes.toString('utf8')
    const body = content.endsWith('\n') ? content.slice(0, -1) : content
    const added = body.length === 0 ? [] : body.split('\n')
    const shown = added.slice(0, MAX_DIFF_LINES)
    return { path, binary: false, truncated: shown.length < added.length,
      lines: [{ kind: 'hunk', text: `@@ -0,0 +1,${added.length} @@` }, ...shown.map((text, i): DiffLine => ({ kind: 'add', text, new: i + 1 }))] }
  }
  const head = await run(projectPath, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => 'HEAD', () => EMPTY_TREE)
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const { stdout } = await run(projectPath, ['diff', head, '-M', '--relative', '--no-color', '--no-ext-diff', '--', ...paths])
  return { path, ...parseUnified(stdout) }
}
