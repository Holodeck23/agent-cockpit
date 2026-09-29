import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const HIDDEN = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'release'])
const MAX_BYTES = 100_000
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
export interface FilePreview { path: string; text: string; bytes: number }

function contained(projectPath: string, path: string): { root: string; target: string } {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('File must be inside the project')
  const root = realpathSync(projectPath)
  const target = realpathSync(resolve(root, path))
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('File must be inside the project')
  if (relative(root, target).split(sep).some((part) => HIDDEN.has(part))) throw new Error('Generated and dependency folders are excluded')
  return { root, target }
}

export function listFiles(projectPath: string, path = ''): FileListing {
  const { root, target } = contained(projectPath, path)
  if (!statSync(target).isDirectory()) throw new Error('Choose a folder')
  const names = readdirSync(target, { withFileTypes: true }).filter((entry) => !HIDDEN.has(entry.name) && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
  names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return { path: relative(root, target), truncated: names.length > 500,
    entries: names.slice(0, 500).map((entry) => ({ name: entry.name, path: relative(root, join(target, entry.name)), kind: entry.isDirectory() ? 'directory' : 'file' })) }
}

export function readProjectFile(projectPath: string, path: string): FilePreview {
  const { root, target } = contained(projectPath, path)
  // Bounded read from one descriptor; reject devices, pipes, directories and binary data.
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
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new Error('Only UTF-8 text files can be previewed or attached') }
    return { path: relative(root, target), text, bytes }
  } finally { closeSync(fd) }
}

/** Percent-encoded relative paths let references handle spaces, #, and Unicode. */
export function expandFiles(text: string, projectPath: string): string {
  let count = 0
  const output = text.replace(/@file:([^\s]+)/g, (_match, encoded: string) => {
    if (++count > 8) throw new Error('Attach at most 8 files per message')
    const file = readProjectFile(projectPath, decodeURIComponent(encoded))
    return `\nProject file: ${file.path}\n<file-content>\n${file.text}\n</file-content>\n`
  })
  if (output.length > 200_000) throw new Error('Message and attached files exceed 200,000 characters')
  return output
}
