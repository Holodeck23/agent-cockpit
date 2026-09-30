import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { contained, explained, HIDDEN, MAX_BYTES, readText, versionOf } from './browser.ts'

// Saving text files from the Files panel. Every save names the version it was
// edited from; if the file changed since (the agent or another editor wrote it),
// the save is refused rather than overwriting that work.

export class FileConflictError extends Error {}
export interface FileSaved { path: string; bytes: number; version: string }

function encode(text: string): Buffer {
  const data = Buffer.from(text, 'utf8')
  if (data.length > MAX_BYTES) throw new Error('Files over 100 KB are read-only here')
  if (data.includes(0)) throw new Error('Text cannot contain NUL characters')
  return data
}

/** Writes beside the target, flushes, then hands the finished file to `place`; never leaves a partial file. */
function writeBeside(target: string, data: Buffer, mode: number, place: (tmp: string) => void): void {
  const tmp = join(dirname(target), `.${basename(target)}.cockpit-${randomUUID()}.tmp`)
  const fd = openSync(tmp, 'wx', mode)
  try {
    try { writeSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
    place(tmp)
  } finally {
    try { unlinkSync(tmp) } catch { /* already moved into place */ }
  }
}

/**
 * `expected` is the version the edit started from, or null to create a new file.
 * New files go in an existing folder, never replace anything, and are not hidden.
 */
export function writeProjectFile(projectPath: string, path: string, text: string, expected: string | null): FileSaved {
  return explained(path, `Not found in this project: ${path}`, () => expected === null ? create(projectPath, path, text) : save(projectPath, path, text, expected))
}

function save(projectPath: string, path: string, text: string, expected: string): FileSaved {
  const { root, target } = contained(projectPath, path)
  if (lstatSync(resolve(root, path)).isSymbolicLink()) throw new Error('Symbolic links are read-only here')
  const current = readText(target).data
  if (versionOf(current) !== expected) throw new FileConflictError('This file changed on disk since you opened it')
  const data = encode(text)
  const mode = statSync(target).mode & 0o777
  writeBeside(target, data, mode, (tmp) => renameSync(tmp, target))
  return { path: relative(root, target), bytes: data.length, version: versionOf(data) }
}

function create(projectPath: string, path: string, text: string): FileSaved {
  const name = basename(path)
  if (!name || name.startsWith('.') || HIDDEN.has(name)) throw new Error('Choose a visible file name')
  const parent = dirname(path) === '.' ? '' : dirname(path)
  const { root, target: folder } = contained(projectPath, parent)
  if (!statSync(folder).isDirectory()) throw new Error('Choose an existing folder')
  const target = join(folder, name)
  const data = encode(text)
  // link() fails if the name exists, so a file created meanwhile is never replaced.
  writeBeside(target, data, 0o644, (tmp) => {
    try { linkSync(tmp, target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileConflictError(`${relative(root, target)} already exists`)
      throw error
    }
  })
  return { path: relative(root, target), bytes: data.length, version: versionOf(data) }
}
