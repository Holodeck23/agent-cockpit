import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { decodeReference, FILE_REFERENCE, MAX_ATTACHED_FILES, MessageReferenceError } from './references.ts'

export const HIDDEN = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release'])
export const MAX_BYTES = 100_000
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
/** `version` is a hash of the bytes read; a save must name it, so edits made meanwhile are never overwritten. */
export interface FilePreview { path: string; text: string; bytes: number; version: string }

export const versionOf = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Filesystem errors carry absolute paths; callers only ever see the project-relative one. */
export function explained<T>(shown: string, missing: string, read: () => T): T {
  try {
    return read()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code !== 'string') throw error
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(missing)
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`Cockpit is not allowed to read ${shown}`)
    throw new Error(`Could not read ${shown}`)
  }
}
const realpathOrExplain = (path: string, shown: string, missing: string): string => explained(shown, missing, () => realpathSync(path))

export function contained(projectPath: string, path: string): { root: string; target: string } {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('File must be inside the project')
  const root = realpathOrExplain(projectPath, 'the project folder', 'Project folder is unavailable')
  const target = realpathOrExplain(resolve(root, path), path || 'the project folder', `Not found in this project: ${path}`)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('File must be inside the project')
  if (relative(root, target).split(sep).some((part) => HIDDEN.has(part))) throw new Error('Generated and dependency folders are excluded')
  return { root, target }
}

export function listFiles(projectPath: string, path = ''): FileListing {
  return explained(path || 'the project folder', `Not found in this project: ${path}`, () => listInside(projectPath, path))
}

function listInside(projectPath: string, path: string): FileListing {
  const { root, target } = contained(projectPath, path)
  if (!statSync(target).isDirectory()) throw new Error('Choose a folder')
  const names = readdirSync(target, { withFileTypes: true }).filter((entry) => !HIDDEN.has(entry.name) && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
  names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return { path: relative(root, target), truncated: names.length > 500,
    entries: names.slice(0, 500).map((entry) => ({ name: entry.name, path: relative(root, join(target, entry.name)), kind: entry.isDirectory() ? 'directory' : 'file' })) }
}

export function readProjectFile(projectPath: string, path: string): FilePreview {
  return explained(path, `Not found in this project: ${path}`, () => readInside(projectPath, path))
}

function readInside(projectPath: string, path: string): FilePreview {
  const { root, target } = contained(projectPath, path)
  const { text, data } = readText(target)
  return { path: relative(root, target), text, bytes: data.length, version: versionOf(data) }
}

/** Bounded read from one descriptor; rejects devices, pipes, directories, binary data and invalid UTF-8. */
export function readText(target: string): { text: string; data: Buffer } {
  if (!statSync(target).isFile()) throw new Error('Choose a text file')
  const fd = openSync(target, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('Choose a text file')
    if (stat.size > MAX_BYTES) throw new Error('Text preview is limited to 100 KB per file')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null)
      if (!count) break
      bytes += count
    }
    if (bytes > MAX_BYTES) throw new Error('Text preview is limited to 100 KB per file')
    const data = buffer.subarray(0, bytes)
    if (data.includes(0)) throw new Error('Binary files cannot be previewed or attached')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) } catch { throw new Error('Only UTF-8 text files can be previewed or attached') }
    return { text, data }
  } finally { closeSync(fd) }
}

/**
 * Percent-encoded relative paths let references handle spaces, #, and Unicode.
 * Returns the text the agent receives; the stored message keeps the references.
 */
export function expandFiles(text: string, projectPath: string): string {
  let count = 0
  const output = text.replace(FILE_REFERENCE, (_match, lead: string, encoded: string) => {
    if (++count > MAX_ATTACHED_FILES) throw new MessageReferenceError(`Attach at most ${MAX_ATTACHED_FILES} files per message`)
    const path = decodeReference(encoded)
    if (path === undefined) throw new MessageReferenceError(`This attachment is not a valid file reference: @file:${encoded}`)
    let file: FilePreview
    try {
      file = readProjectFile(projectPath, path)
    } catch (error) {
      throw new MessageReferenceError(error instanceof Error ? error.message : `Could not attach ${path}`)
    }
    return `${lead}\nProject file: ${file.path}\n<file-content>\n${file.text}\n</file-content>\n`
  })
  if (output.length > 200_000) throw new MessageReferenceError('Message and attached files exceed 200,000 characters')
  return output
}
