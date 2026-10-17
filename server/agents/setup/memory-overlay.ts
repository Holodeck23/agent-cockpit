// Selected native memory is copied into a private run-owned folder. Source files are never edited.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_FILES = 256
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 1024
interface MemoryFile { readonly relativePath: string; readonly bytes: Buffer }

function within(root: string, path: string): boolean {
  const from = relative(root, path)
  return from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
}

// Resolve every existing ancestor before creating a destination. On macOS /var aliases
// /private/var, so comparing an unresolved new path with realpath(source) is unsafe.
function physicalPath(path: string): string {
  let ancestor = resolve(path)
  const missing: string[] = []
  while (true) {
    try { lstatSync(ancestor); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
  return resolve(realpathSync(ancestor), ...missing)
}

function readTree(sourceDir: string): { readonly revision: string; readonly files: readonly MemoryFile[] } {
  if (!isAbsolute(sourceDir)) throw new Error('Native memory source must be absolute')
  const root = resolve(sourceDir)
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Native memory source is linked or not a directory')
  const files: MemoryFile[] = []
  let total = 0
  let entries = 0
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (++entries > MAX_ENTRIES) throw new Error('Native memory exceeds the reviewed entry limit')
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Native memory contains a linked entry')
      const relativePath = prefix ? join(prefix, name) : name
      if (stat.isDirectory()) { walk(path, relativePath); continue }
      if (!stat.isFile()) throw new Error('Native memory contains a non-file entry')
      if (files.length >= MAX_FILES || total + stat.size > MAX_BYTES) throw new Error('Native memory exceeds the reviewed source limit')
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile()) throw new Error('Native memory changed to a non-file during review')
        if (opened.size > MAX_BYTES - total) throw new Error('Native memory changed beyond the reviewed source limit')
        bytes = Buffer.alloc(opened.size)
        let offset = 0
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, null)
          if (count === 0) throw new Error('Native memory changed during review')
          offset += count
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error('Native memory changed during review')
      } finally { closeSync(fd) }
      total += bytes.length
      if (total > MAX_BYTES) throw new Error('Native memory changed beyond the reviewed source limit')
      files.push({ relativePath, bytes })
    }
  }
  walk(root, '')
  if (!files.some((file) => file.relativePath === 'MEMORY.md')) throw new Error('Native memory has no root MEMORY.md')
  const digest = createHash('sha256')
  for (const file of files) digest.update(file.relativePath).update('\0').update(file.bytes).update('\0')
  return { revision: digest.digest('hex'), files }
}

/** Read-only revision for a selected source. Keep it private; memory hashes may reveal content equality. */
export function snapshotNativeMemory(sourceDir: string): { readonly revision: string; readonly fileCount: number } {
  const source = readTree(sourceDir)
  return { revision: source.revision, fileCount: source.files.length }
}

/** Materialize only an exactly selected revision; the returned overlay may later contain unique provider writes. */
export function materializeNativeMemory(sourceDir: string, privateRoot: string, approvedRevision: string):
  { readonly directory: string; readonly sourceRevision: string; readonly fileCount: number } {
  if (!isAbsolute(privateRoot) || !/^[a-f0-9]{64}$/.test(approvedRevision)) throw new Error('Invalid native memory selection')
  const source = readTree(sourceDir)
  if (source.revision !== approvedRevision) throw new Error('Native memory changed after selection')
  const sourceReal = realpathSync(sourceDir)
  if (within(sourceReal, physicalPath(privateRoot))) throw new Error('Native memory destination is inside the source')
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
  const rootStat = lstatSync(privateRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) {
    throw new Error('Native memory destination must be a private directory')
  }
  const privateReal = realpathSync(privateRoot)
  if (within(sourceReal, privateReal)) throw new Error('Native memory destination is inside the source')
  const overlay = mkdtempSync(join(privateReal, 'memory-'))
  try {
    chmodSync(overlay, 0o700)
    for (const file of source.files) {
      const target = join(overlay, file.relativePath)
      if (!within(overlay, target)) throw new Error('Native memory path escaped the overlay')
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(target, file.bytes, { mode: 0o600, flag: 'wx' })
    }
    if (readTree(sourceDir).revision !== approvedRevision) throw new Error('Native memory changed during materialization')
  } catch (error) {
    // No provider has received this new overlay, so it contains no unique provider writes.
    rmSync(overlay, { recursive: true, force: true })
    throw error
  }
  return { directory: overlay, sourceRevision: approvedRevision, fileCount: source.files.length }
}
