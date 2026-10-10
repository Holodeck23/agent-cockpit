import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Stable content hash for an application bundle: paths, types, modes, symlink targets and bytes. */
export function hashPackageTree(root: string): string {
  const hash = createHash('sha256')
  const field = (value: string): void => {
    hash.update(`${Buffer.byteLength(value)}:`)
    hash.update(value)
  }
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path)
    const mode = (stat.mode & 0o7777).toString(8)
    if (stat.isDirectory()) {
      field('directory'); field(relative); field(mode)
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), relative ? `${relative}/${entry}` : entry)
      return
    }
    if (stat.isSymbolicLink()) {
      field('symlink'); field(relative); field(mode); field(readlinkSync(path))
      return
    }
    if (stat.isFile()) {
      field('file'); field(relative); field(mode); field(String(stat.size))
      hash.update(readFileSync(path))
      return
    }
    field('other'); field(relative); field(mode)
  }
  visit(root, '')
  return hash.digest('hex')
}
