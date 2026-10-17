// The user's own Claude skills, commands and agents, projected into a private plugin folder the
// provider loads with --plugin-dir. Pinned Claude 2.1.220 loads such a plugin under empty setting
// sources and answers to bare skill names (W13 U6 receipts), so nothing else from the profile is
// opened up. A projection is an immutable copy of one reviewed revision; the source is never passed.
// A linked entry is copied only once the user has included that link, and only while it still
// points at the folder or file they reviewed.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const PROJECTION_PLUGIN = 'my-setup'
const ROOTS = ['skills', 'commands', 'agents'] as const
const MAX_FILES = 5000
const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface SkillSourceFile { readonly relativePath: string; readonly bytes: Buffer }
/** A link the user included: its place in the profile and the real folder or file it pointed at then. */
export interface SkillLink { readonly path: string; readonly target: string }
export interface SkillExclusion {
  readonly path: string
  readonly reason: 'linked' | 'not-a-file' | 'too-large'
  /** For a link: where it points now, when that can be read. */
  readonly target?: string
  /** A link directly under skills/, commands/ or agents/ that resolves: the user may review and include it. */
  readonly includable?: boolean
}
export interface SkillSourceSnapshot {
  readonly revision: string
  readonly files: readonly SkillSourceFile[]
  readonly skills: readonly string[]
  readonly commands: readonly string[]
  readonly agents: readonly string[]
  /** Not projected, by relative path: links not included (review first) and anything over the bounds. */
  readonly excluded: readonly SkillExclusion[]
  /** Included links whose content is in this revision. */
  readonly included: readonly SkillLink[]
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

const resolved = (path: string): string | undefined => { try { return realpathSync(path) } catch { return undefined } }

/**
 * Reads the profile's skills, commands and agents. No link is followed, except an included one that
 * still points at its reviewed target; inside it, links are again not followed.
 */
export function snapshotSkillSource(profileDir: string, include: readonly SkillLink[] = []): SkillSourceSnapshot {
  if (!isAbsolute(profileDir)) throw new Error('Skill source must be absolute')
  const files: SkillSourceFile[] = []
  const excluded: SkillExclusion[] = []
  const included: SkillLink[] = []
  let total = 0
  const take = (path: string, relativePath: string, size: number): void => {
    if (size > MAX_FILE_BYTES) { excluded.push({ path: relativePath, reason: 'too-large' }); return }
    if (files.length >= MAX_FILES || total + size > MAX_BYTES) throw new Error('Your skills exceed the projection limit')
    const bytes = readExact(path)
    total += bytes.length
    files.push({ relativePath, bytes })
  }
  const walk = (dir: string, rel: string, topLevel: boolean): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), relativePath = join(rel, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) { linked(path, relativePath, topLevel); continue }
      if (stat.isDirectory()) { walk(path, relativePath, false); continue }
      if (!stat.isFile()) { excluded.push({ path: relativePath, reason: 'not-a-file' }); continue }
      take(path, relativePath, stat.size)
    }
  }
  const linked = (path: string, relativePath: string, topLevel: boolean): void => {
    const target = resolved(path)
    const chosen = include.find((link) => link.path === relativePath)
    if (topLevel && target !== undefined && chosen?.target === target) {
      included.push(chosen)
      const stat = statSync(target)
      if (stat.isDirectory()) walk(target, relativePath, false)
      else if (stat.isFile()) take(target, relativePath, stat.size)
      else excluded.push({ path: relativePath, reason: 'not-a-file' })
      return
    }
    const kind = target === undefined ? undefined : statSync(target)
    const includable = topLevel && kind !== undefined && (kind.isDirectory() || kind.isFile())
    excluded.push({ path: relativePath, reason: 'linked', ...(target !== undefined ? { target } : {}), ...(includable ? { includable } : {}) })
  }
  for (const root of ROOTS) {
    const dir = join(profileDir, root)
    if (!existsSync(dir)) continue
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink()) { excluded.push({ path: root, reason: 'linked' }); continue }
    if (stat.isDirectory()) walk(dir, root, true)
  }
  const digest = createHash('sha256')
  for (const file of files) digest.update(file.relativePath).update('\0').update(file.bytes).update('\0')
  // Which link was included, and where it pointed, is part of what was reviewed.
  for (const link of included) digest.update('link\0').update(link.path).update('\0').update(link.target).update('\0')
  const under = (root: string): string[] => files.filter((f) => f.relativePath.startsWith(`${root}${sep}`)).map((f) => f.relativePath.slice(root.length + 1))
  return {
    revision: digest.digest('hex'), files, excluded, included,
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
