import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'

// <root>/projects.json: the folders the cockpit knows about. Pinned ones are the
// tabs across the top; the rest show up under "Projects ▾" as recent.

export const PROJECT_COLORS = ['blue', 'pink', 'orange', 'green', 'purple', 'gray'] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]

const projectSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(80),
  color: z.enum(PROJECT_COLORS),
  pinned: z.boolean(),
  lastOpenedAt: z.string(),
})
export type Project = z.output<typeof projectSchema>

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  pinned: z.boolean().optional(),
})
export type ProjectPatch = z.output<typeof projectPatchSchema>

export interface ProjectStore {
  /** Most recently opened first. */
  list(): Project[]
  /** Registers folders not yet known (unpinned), dated by their latest thread; leaves known ones alone. */
  ensure(seen: ReadonlyArray<{ path: string; at: string }>): void
  /** Creates or updates a project and marks it opened now. */
  open(path: string, patch?: ProjectPatch): Project
}

/** Stable colour per folder, so a project keeps its colour before anyone picks one. */
export function colorFor(path: string): ProjectColor {
  let hash = 0
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[hash % (PROJECT_COLORS.length - 1)] ?? 'blue'
}

function fresh(path: string, now: string): Project {
  return { path, name: basename(path) || path, color: colorFor(path), pinned: false, lastOpenedAt: now }
}

export function createProjectStore(root: string): ProjectStore {
  const file = join(root, 'projects.json')

  const read = (): Project[] => {
    if (!existsSync(file)) return []
    try {
      const parsed = z.array(projectSchema).safeParse(JSON.parse(readFileSync(file, 'utf8')))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }
  const write = (projects: readonly Project[]): void => {
    writeFileSync(`${file}.tmp`, JSON.stringify(projects, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const assertPath = (path: string): void => {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
  }

  return {
    list() {
      return read().sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
    },
    ensure(seen) {
      const current = read()
      const known = new Set(current.map((p) => p.path))
      const added = new Map<string, Project>()
      for (const { path, at } of seen) {
        if (!isAbsolute(path) || known.has(path)) continue
        const prior = added.get(path)
        if (!prior || prior.lastOpenedAt < at) added.set(path, fresh(path, at))
      }
      if (added.size > 0) write([...current, ...added.values()])
    },
    open(path, patch = {}) {
      assertPath(path)
      const current = read()
      const now = new Date().toISOString()
      const existing = current.find((p) => p.path === path) ?? fresh(path, now)
      const next: Project = { ...existing, ...patch, lastOpenedAt: now }
      write([...current.filter((p) => p.path !== path), next])
      return next
    },
  }
}
