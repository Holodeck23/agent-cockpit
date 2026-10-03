import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'

// <root>/projects.json: the folders the cockpit knows about. Pinned ones are the
// tabs across the top; the rest show up under "Projects ▾" as recent.

export const PROJECT_COLORS = ['blue', 'pink', 'orange', 'green', 'purple', 'gray'] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]
/** Enough for real guidance, small enough to stay a fraction of any agent's context. */
export const MAX_INSTRUCTIONS_CHARS = 8000

const projectSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(80),
  color: z.enum(PROJECT_COLORS),
  pinned: z.boolean(),
  /** Pinned projects are tabs in this order: each new pin goes last. Absent when unpinned. */
  pinOrder: z.number().int().min(1).optional(),
  lastOpenedAt: z.string(),
  /** Added to every agent session started in this project; never changes permissions. */
  instructions: z.string().max(MAX_INSTRUCTIONS_CHARS).optional(),
  /** Bumped on every change, so a session can say which version it started with. */
  instructionsRevision: z.number().int().min(0).optional(),
  /** File name of the project's picture in <root>/project-images, if one was chosen. */
  image: z.string().regex(/^[a-f0-9]{16}-\d+\.(png|jpg|gif|webp)$/).optional(),
  /** Removed from Cockpit: off the tabs and the menu, folder and conversations untouched. Opening it again brings it back. */
  hidden: z.boolean().optional(),
})
export type Project = z.output<typeof projectSchema>

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  pinned: z.boolean().optional(),
  /** Empty clears them. */
  instructions: z.string().max(MAX_INSTRUCTIONS_CHARS).optional(),
})
export type ProjectPatch = z.output<typeof projectPatchSchema>

export interface ProjectStore {
  /** Most recently opened first. Removed projects only with `includeHidden`. */
  list(options?: { includeHidden?: boolean }): Project[]
  /** Registers folders not yet known (unpinned), dated by their latest thread; leaves known ones alone. */
  ensure(seen: ReadonlyArray<{ path: string; at: string }>): void
  /** Creates or updates a project and marks it opened now. */
  open(path: string, patch?: ProjectPatch): Project
  /** Sets or clears the picture's file name; the caller stores the file. */
  setImage(path: string, image: string | undefined): Project
  /** Takes a project off the tabs and the menu. Never touches the folder. */
  hide(path: string): Project
}

/** Stable colour per folder, so a project keeps its colour before anyone picks one. */
export function colorFor(path: string): ProjectColor {
  let hash = 0
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[hash % (PROJECT_COLORS.length - 1)] ?? 'blue'
}

/** New text bumps the revision; the same text (after trimming) changes nothing. */
function instructionsChange(existing: Project, raw: string | undefined): Partial<Project> {
  if (raw === undefined) return {}
  const text = raw.trim()
  if (text === (existing.instructions ?? '')) return {}
  return { instructions: text || undefined, instructionsRevision: (existing.instructionsRevision ?? 0) + 1 }
}

/** A new pin goes after every other; unpinning drops the number. */
function pinChange(all: readonly Project[], existing: Project, pinned: boolean | undefined): Partial<Project> {
  if (pinned === false) return { pinOrder: undefined }
  if (pinned !== true || existing.pinned) return {}
  return { pinOrder: Math.max(0, ...all.map((p) => p.pinOrder ?? 0)) + 1 }
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
    list(options = {}) {
      return read().filter((p) => options.includeHidden || !p.hidden).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
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
      const { instructions: rawInstructions, ...rest } = patch
      // Opening a removed project on purpose brings it back.
      const next: Project = { ...existing, ...rest, hidden: undefined, lastOpenedAt: now, ...instructionsChange(existing, rawInstructions), ...pinChange(current, existing, rest.pinned) }
      write([...current.filter((p) => p.path !== path), next])
      return next
    },
    setImage(path, image) {
      const current = read()
      const existing = current.find((p) => p.path === path && !p.hidden)
      if (!existing) throw new Error('Unknown project')
      const next = projectSchema.parse({ ...existing, image })
      write(current.map((p) => (p.path === path ? next : p)))
      return next
    },
    hide(path) {
      const current = read()
      const existing = current.find((p) => p.path === path && !p.hidden)
      if (!existing) throw new Error('Unknown project')
      const next: Project = { ...existing, hidden: true, pinned: false, pinOrder: undefined }
      write(current.map((p) => (p.path === path ? next : p)))
      return next
    },
  }
}
