// The user's own Claude skills, commands and agents, projected into a private plugin folder the
// provider loads with --plugin-dir. Pinned Claude 2.1.220 loads such a plugin under empty setting
// sources and answers to bare skill names (W13 U6 receipts), so nothing else from the profile is
// opened up. A projection is an immutable copy of one reviewed revision; the source is never passed.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const PROJECTION_PLUGIN = 'my-setup'
const ROOTS = ['skills', 'commands', 'agents'] as const
const MAX_FILES = 5000
const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface SkillSourceFile { readonly relativePath: string; readonly bytes: Buffer }
export interface SkillSourceSnapshot {
  readonly revision: string
  readonly files: readonly SkillSourceFile[]
  readonly skills: readonly string[]
  readonly commands: readonly string[]
  readonly agents: readonly string[]
  /** Not projected, by relative path: linked entries (review first) and anything over the bounds. */
  readonly excluded: readonly { readonly path: string; readonly reason: 'linked' | 'not-a-file' | 'too-large' }[]
}

function readExact(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const size = fstatSync(fd).size
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, null)
      if (count === 0) throw new Error('A skill file changed while it was read')
      offset += count
    }
    return bytes
  } finally { closeSync(fd) }
}

/** Reads the profile's skills, commands and agents without following any link. */
export function snapshotSkillSource(profileDir: string): SkillSourceSnapshot {
  if (!isAbsolute(profileDir)) throw new Error('Skill source must be absolute')
  const files: SkillSourceFile[] = []
  const excluded: { path: string; reason: 'linked' | 'not-a-file' | 'too-large' }[] = []
  let total = 0
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), relativePath = join(rel, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) { excluded.push({ path: relativePath, reason: 'linked' }); continue }
      if (stat.isDirectory()) { walk(path, relativePath); continue }
      if (!stat.isFile()) { excluded.push({ path: relativePath, reason: 'not-a-file' }); continue }
      if (stat.size > MAX_FILE_BYTES) { excluded.push({ path: relativePath, reason: 'too-large' }); continue }
      if (files.length >= MAX_FILES || total + stat.size > MAX_BYTES) throw new Error('Your skills exceed the projection limit')
      const bytes = readExact(path)
      total += bytes.length
      files.push({ relativePath, bytes })
    }
  }
  for (const root of ROOTS) {
    const dir = join(profileDir, root)
    if (!existsSync(dir)) continue
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink()) { excluded.push({ path: root, reason: 'linked' }); continue }
    if (stat.isDirectory()) walk(dir, root)
  }
  const digest = createHash('sha256')
  for (const file of files) digest.update(file.relativePath).update('\0').update(file.bytes).update('\0')
  const under = (root: string): string[] => files.filter((f) => f.relativePath.startsWith(`${root}${sep}`)).map((f) => f.relativePath.slice(root.length + 1))
  return {
    revision: digest.digest('hex'), files, excluded,
    skills: [...new Set(under('skills').filter((p) => p.endsWith(`${sep}SKILL.md`) && p.split(sep).length === 2).map((p) => p.split(sep)[0]!))],
    commands: under('commands').filter((p) => p.endsWith('.md')).map((p) => p.slice(0, -3).split(sep).join(':')),
    agents: under('agents').filter((p) => p.endsWith('.md') && !p.includes(sep)).map((p) => p.slice(0, -3)),
  }
}

/**
 * The private plugin folder for exactly this revision, made once and then reused. Built beside its
 * final name and renamed into place, so a half-written projection is never loaded.
 */
export function materializeSkillProjection(source: SkillSourceSnapshot, root: string): string {
  if (!isAbsolute(root) || !/^[a-f0-9]{64}$/.test(source.revision)) throw new Error('Invalid skill projection')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const final = join(root, source.revision)
  if (existsSync(join(final, '.cockpit-complete'))) return final
  rmSync(final, { recursive: true, force: true })
  const building = mkdtempSync(join(root, 'building-'))
  try {
    chmodSync(building, 0o700)
    mkdirSync(join(building, '.claude-plugin'), { mode: 0o700 })
    writeFileSync(join(building, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PROJECTION_PLUGIN, version: '1.0.0',
      description: 'Your own Claude skills, commands and agents, as reviewed in Cockpit' }), { mode: 0o600 })
    for (const file of source.files) {
      const target = resolve(building, file.relativePath)
      const from = relative(building, target)
      if (from.startsWith('..') || isAbsolute(from)) throw new Error('Skill path escaped the projection')
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(target, file.bytes, { mode: 0o600, flag: 'wx' })
    }
    writeFileSync(join(building, '.cockpit-complete'), source.revision, { mode: 0o600 })
    renameSync(building, final)
  } catch (error) {
    rmSync(building, { recursive: true, force: true })
    throw error
  }
  return final
}
