import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

// Libraries (projects-area plan, Move 2): folders the person adds so Cockpit can propose areas and
// projects from what is already on disk. A scan only reads: readdir, stat, lstat, realpath, and one
// file (a project's memory.md). Every path is compared by its real path, so a symlink never makes
// the same folder appear twice, and a symlink into another library is skipped (that library lists it).

export interface Library {
  /** The folder as the person added it. */
  readonly root: string
  /** Mac only: never shown on the phone. Carried onto every area of the library. */
  readonly private?: boolean
}

export const LAYER_IDS = ['identity', 'substrate', 'rules', 'skills', 'tools', 'agents'] as const
export type LayerId = (typeof LAYER_IDS)[number]
/** present = found on disk; the other three come from an os-coach memory.md "Layer status" block. */
export type LayerState = 'missing' | 'in-progress' | 'present' | 'solid'

export interface Layer {
  readonly id: LayerId
  readonly state: LayerState
  /** That layer's own entry's mtime (no recursion), when the entry exists. */
  readonly changedAt?: string
}

export interface LibraryProject {
  /** Real path. */
  readonly path: string
  readonly name: string
  readonly children: readonly LibraryProject[]
  readonly layers: readonly Layer[]
  readonly lastChangedAt?: string
}

export interface LibraryArea {
  /** Stable: derived from the area folder's real path. */
  readonly id: string
  readonly name: string
  /** Real path of the area folder (the library root itself for "Loose"). */
  readonly root: string
  readonly private: boolean
  /** parked, archive, … : shown collapsed. */
  readonly shelf: boolean
  readonly projects: readonly LibraryProject[]
}

export interface LibraryScan {
  readonly root: string
  readonly areas: readonly LibraryArea[]
  /** The directory budget ran out; some folders were not looked at. */
  readonly truncated: boolean
}

/** The few file-system calls a scan makes; tests and callers may pass their own. */
export interface ScanFs {
  realpath(path: string): string
  /** Entry names of a directory. */
  readdir(path: string): string[]
  /** stat (follows links); undefined when missing or unreadable. */
  stat(path: string): { isDirectory(): boolean; mtimeMs: number } | undefined
  isSymlink(path: string): boolean
  readFile(path: string): string | undefined
}

export const nodeScanFs: ScanFs = {
  realpath: (path) => realpathSync(path),
  readdir: (path) => readdirSync(path),
  stat: (path) => { try { return statSync(path) } catch { return undefined } },
  isSymlink: (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } },
  readFile: (path) => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
}

export const MAX_DIRECTORIES = 2000
const SHELF_NAMES = new Set(['parked', 'archive', 'archived', 'third-party', 'vendor'])
const SKIP_NAMES = new Set(['node_modules'])
const PROJECT_MARKERS = ['.git', 'CLAUDE.md', 'AGENTS.md']
const LAYER_ENTRIES: Record<LayerId, readonly string[]> = {
  identity: ['CLAUDE.md', 'AGENTS.md'],
  substrate: ['substrate', 'context', 'knowledge', '_raw', 'research'],
  rules: ['rules', '.claude/rules', '.claude/settings.json'],
  skills: ['skills', '.claude/skills'],
  tools: ['tools.md', '.mcp.json'],
  agents: ['agents', '.claude/agents'],
}

export function areaId(realRoot: string, suffix = ''): string {
  return `a_${createHash('sha256').update(realRoot + suffix).digest('hex').slice(0, 12)}`
}

/** Inside or equal: compares whole path segments, never string prefixes ("/a/bc" is not inside "/a/b"). */
export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** os-coach's `## Layer status` block: `- Identity: not started | in progress | solid - note`. */
export function parseLayerStatus(text: string): Partial<Record<LayerId, LayerState>> {
  const block = /^##\s+Layer status\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text)?.[1] ?? ''
  const out: Partial<Record<LayerId, LayerState>> = {}
  for (const line of block.split('\n')) {
    const m = /^\s*[-*]\s*([A-Za-z &]+?)\s*:\s*(not started|in progress|solid)\b/i.exec(line)
    if (!m) continue
    const id = LAYER_IDS.find((l) => m[1]!.toLowerCase().startsWith(l.slice(0, 4)))
    if (!id) continue
    const value = m[2]!.toLowerCase()
    out[id] = value === 'solid' ? 'solid' : value === 'in progress' ? 'in-progress' : 'missing'
  }
  return out
}

function readLayers(dir: string, fs: ScanFs): Layer[] {
  const memory = fs.readFile(join(dir, 'memory.md'))
  const declared = memory ? parseLayerStatus(memory) : {}
  return LAYER_IDS.map((id) => {
    const found = LAYER_ENTRIES[id].map((entry) => fs.stat(join(dir, entry))).find((s) => s !== undefined)
    const changedAt = found ? new Date(found.mtimeMs).toISOString() : undefined
    const state = declared[id] ?? (found ? 'present' : 'missing')
    return changedAt ? { id, state, changedAt } : { id, state }
  })
}

const isProjectDir = (dir: string, fs: ScanFs): boolean => PROJECT_MARKERS.some((m) => fs.stat(join(dir, m)) !== undefined)
const displayName = (path: string): string => basename(path).trim() || basename(path)

interface Entry { readonly real: string; readonly name: string }

/**
 * Scans one library. `others` are the other libraries' roots: a symlink pointing into one of them is
 * skipped. `known` are projects Cockpit already has (projects.json paths); one that lies inside a
 * scanned project is nested under the deepest such project.
 */
export function scanLibrary(library: Library, others: readonly string[], fs: ScanFs = nodeScanFs, known: readonly string[] = []): LibraryScan {
  const root = fs.realpath(library.root)
  const otherRoots = others.flatMap((o) => { try { return [fs.realpath(o)] } catch { return [] } }).filter((o) => o !== root)
  const seen = new Set<string>()
  let budget = MAX_DIRECTORIES
  let truncated = false

  /** Child directories of `dir`, real-path resolved, deduplicated across the whole scan. */
  const children = (dir: string): Entry[] => {
    if (budget <= 0) { truncated = true; return [] }
    budget -= 1
    let names: string[]
    try { names = fs.readdir(dir) } catch { return [] }
    const out: Entry[] = []
    for (const name of names.sort()) {
      if (name.startsWith('.') || SKIP_NAMES.has(name)) continue
      const full = join(dir, name)
      if (!fs.stat(full)?.isDirectory()) continue
      let real: string
      try { real = fs.realpath(full) } catch { continue } // a symlink loop or a dangling link
      // A link to a folder inside this library or another one: that folder is listed where it really lives.
      if (fs.isSymlink(full) && (isInside(real, root) || otherRoots.some((o) => isInside(real, o)))) continue
      if (isInside(root, real) || seen.has(real)) continue // a link back up the tree, or listed already
      seen.add(real)
      out.push({ real, name })
    }
    return out
  }

  const project = (entry: Entry, depth: number): LibraryProject => {
    const kids = depth < 3 ? children(entry.real).filter((c) => isProjectDir(c.real, fs)).map((c) => project(c, depth + 1)) : []
    const mtime = fs.stat(entry.real)?.mtimeMs
    return {
      path: entry.real,
      name: entry.name.trim() || entry.name,
      children: kids,
      layers: readLayers(entry.real, fs),
      ...(mtime !== undefined ? { lastChangedAt: new Date(mtime).toISOString() } : {}),
    }
  }

  const priv = library.private === true
  const loose: LibraryProject[] = []
  const areas: LibraryArea[] = []
  seen.add(root)
  for (const top of children(root)) {
    // A repo at the top is a project. A folder with its own CLAUDE.md and folders inside is an area
    // whose instructions sit above its projects; with nothing inside, it is a project too.
    if (fs.stat(join(top.real, '.git'))) { loose.push(project(top, 1)); continue }
    const inside = children(top.real)
    if (inside.length === 0) { if (isProjectDir(top.real, fs)) loose.push(project(top, 1)); continue }
    const name = top.name.trim() || top.name
    areas.push({
      id: areaId(top.real), name, root: top.real, private: priv,
      shelf: SHELF_NAMES.has(name.toLowerCase()),
      projects: inside.map((p) => project(p, 2)),
    })
  }
  if (loose.length > 0) areas.push({ id: areaId(root, '#loose'), name: 'Loose', root, private: priv, shelf: false, projects: loose })

  return { root, areas: nestKnown(areas, known, fs), truncated }
}

/** Puts each known project that lies inside a scanned project under the deepest one, unless already listed. */
function nestKnown(areas: LibraryArea[], known: readonly string[], fs: ScanFs): LibraryArea[] {
  const listed = new Set<string>()
  const walk = (ps: readonly LibraryProject[]): void => ps.forEach((p) => { listed.add(p.path); walk(p.children) })
  areas.forEach((a) => walk(a.projects))
  const extra = known.flatMap((k) => { try { return [fs.realpath(k)] } catch { return [] } }).filter((k) => !listed.has(k))
  if (extra.length === 0) return areas
  const insert = (ps: readonly LibraryProject[], path: string): readonly LibraryProject[] | undefined => {
    const parent = ps.find((p) => isInside(path, p.path) && p.path !== path)
    if (!parent) return undefined
    const deeper = insert(parent.children, path)
    const nextChildren = deeper ?? [...parent.children, { path, name: displayName(path), children: [], layers: readLayers(path, fs) }]
    return ps.map((p) => (p === parent ? { ...p, children: nextChildren } : p))
  }
  return areas.map((area) => extra.reduce((a, path) => {
    if (listed.has(path)) return a
    const next = insert(a.projects, path)
    if (!next) return a
    listed.add(path)
    return { ...a, projects: next }
  }, area))
}

/** Every project path in a scan, depth first. */
export function scanPaths(scan: LibraryScan): string[] {
  const out: string[] = []
  const walk = (ps: readonly LibraryProject[]): void => ps.forEach((p) => { out.push(p.path); walk(p.children) })
  scan.areas.forEach((a) => walk(a.projects))
  return out
}
