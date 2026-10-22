import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '../files/atomic.ts'
import { StoreReadError } from '../state/read-error.ts'
import { isInside } from './libraries.ts'

// <root>/navigation.json: how the person arranges the Projects area (libraries, areas, where each
// project sits, names on the Map, Mac only). It is a file of its own, never fields on projects.json:
// projects.json is rewritten from what a build knows, so an older Cockpit would drop new fields there.
// Here every object is parsed loosely and written back with keys this build does not know, so a
// newer build's additions survive an older one. Nothing in this file ever moves a folder on disk.

export const NAVIGATION_VERSION = 1
const MAX_NAME = 80
const MAX_PATH = 1000

const librarySchema = z.looseObject({ root: z.string().min(1), private: z.boolean().optional() })
const areaSchema = z.looseObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_NAME).optional(),
  private: z.boolean().optional(),
  hidden: z.boolean().optional(),
  order: z.number().optional(),
  /** Made by the person (not proposed from a library folder). */
  custom: z.boolean().optional(),
  /** A shelf the person opened (shelves start collapsed). */
  open: z.boolean().optional(),
})
const navigationSchema = z.looseObject({
  version: z.number().int().min(1),
  libraries: z.array(librarySchema).default([]),
  areas: z.array(areaSchema).default([]),
  /** Real path → area id. */
  placement: z.record(z.string(), z.string()).default({}),
  /** Real path → the name shown on the Map. */
  names: z.record(z.string(), z.string()).default({}),
  collapsed: z.array(z.string()).default([]),
  /** Real paths of single projects marked Mac only. */
  privateProjects: z.array(z.string()).default([]),
})
export type Navigation = z.output<typeof navigationSchema>
export type NavigationArea = z.output<typeof areaSchema>

const name = z.string().trim().min(1).max(MAX_NAME)
const path = z.string().min(1).max(MAX_PATH)
const id = z.string().min(1).max(64)
export const navigationOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addLibrary'), root: path, private: z.boolean().optional() }),
  z.object({ op: z.literal('removeLibrary'), root: path }),
  z.object({ op: z.literal('setLibraryPrivate'), root: path, private: z.boolean() }),
  z.object({ op: z.literal('createArea'), name }),
  z.object({ op: z.literal('renameArea'), id, name }),
  z.object({ op: z.literal('hideArea'), id, hidden: z.boolean() }),
  z.object({ op: z.literal('setAreaPrivate'), id, private: z.boolean() }),
  z.object({ op: z.literal('reorderAreas'), ids: z.array(id).max(500) }),
  z.object({ op: z.literal('setCollapsed'), id, collapsed: z.boolean() }),
  /** `areaId: null` puts the project back where its library proposes. */
  z.object({ op: z.literal('moveProject'), path, areaId: id.nullable() }),
  /** `name: null` goes back to the folder's name. */
  z.object({ op: z.literal('renameProject'), path, name: name.nullable() }),
  z.object({ op: z.literal('setProjectPrivate'), path, private: z.boolean() }),
])
export type NavigationOp = z.output<typeof navigationOpSchema>

export class NavigationError extends Error {}

export const emptyNavigation = (): Navigation => navigationSchema.parse({ version: NAVIGATION_VERSION })

const upsertArea = (nav: Navigation, areaId: string, patch: Partial<NavigationArea>): Navigation => {
  const existing = nav.areas.find((a) => a.id === areaId)
  if (existing) return { ...nav, areas: nav.areas.map((a) => (a.id === areaId ? { ...a, ...patch } : a)) }
  const order = Math.max(0, ...nav.areas.map((a) => a.order ?? 0)) + 1
  return { ...nav, areas: [...nav.areas, { id: areaId, order, ...patch }] }
}
const withFlag = (list: readonly string[], value: string, on: boolean): string[] =>
  on ? [...new Set([...list, value])] : list.filter((v) => v !== value)
const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

/**
 * Applies one change and returns the new navigation; never mutates `nav`. Library roots and project
 * paths arrive already resolved to real paths (the route does that); area ids are checked there too.
 */
export function applyNavigationOp(nav: Navigation, op: NavigationOp, newId: () => string = () => `n_${randomBytes(6).toString('hex')}`): Navigation {
  switch (op.op) {
    case 'addLibrary': {
      if (!isAbsolute(op.root)) throw new NavigationError('Choose a folder by its full path')
      const clash = nav.libraries.find((l) => isInside(op.root, l.root) || isInside(l.root, op.root))
      if (clash) throw new NavigationError(clash.root === op.root ? 'That folder is already a library' : 'That folder overlaps a library you already added')
      return { ...nav, libraries: [...nav.libraries, op.private ? { root: op.root, private: true } : { root: op.root }] }
    }
    case 'removeLibrary':
      return { ...nav, libraries: nav.libraries.filter((l) => l.root !== op.root) }
    case 'setLibraryPrivate':
      if (!nav.libraries.some((l) => l.root === op.root)) throw new NavigationError('Unknown library')
      return { ...nav, libraries: nav.libraries.map((l) => (l.root === op.root ? { ...l, private: op.private } : l)) }
    case 'createArea':
      return upsertArea(nav, newId(), { name: op.name, custom: true })
    case 'renameArea':
      return upsertArea(nav, op.id, { name: op.name })
    case 'hideArea':
      return upsertArea(nav, op.id, { hidden: op.hidden })
    case 'setAreaPrivate':
      return upsertArea(nav, op.id, { private: op.private })
    case 'reorderAreas': {
      const placed = op.ids.reduce((n, areaId, i) => upsertArea(n, areaId, { order: i + 1 }), nav)
      // Areas not named keep their relative order, after the named ones.
      const rest = placed.areas.filter((a) => !op.ids.includes(a.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      return rest.reduce((n, a, i) => upsertArea(n, a.id, { order: op.ids.length + i + 1 }), placed)
    }
    case 'setCollapsed':
      return { ...upsertArea(nav, op.id, { open: !op.collapsed }), collapsed: withFlag(nav.collapsed, op.id, op.collapsed) }
    case 'moveProject':
      return { ...nav, placement: op.areaId === null ? without(nav.placement, op.path) : { ...nav.placement, [op.path]: op.areaId } }
    case 'renameProject':
      return { ...nav, names: op.name === null ? without(nav.names, op.path) : { ...nav.names, [op.path]: op.name } }
    case 'setProjectPrivate':
      return { ...nav, privateProjects: withFlag(nav.privateProjects, op.path, op.private) }
  }
}

export interface NavigationStore {
  readonly file: string
  /** An empty navigation when the file does not exist yet. */
  read(): Navigation
  update(op: NavigationOp): Navigation
}

export function createNavigationStore(root: string): NavigationStore {
  const file = join(root, 'navigation.json')
  // Unreadable is never empty: an empty navigation would be written back over the person's arrangement.
  const read = (): Navigation => {
    if (!existsSync(file)) return emptyNavigation()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new StoreReadError('UNREADABLE', file, 'not valid JSON') }
    const version = (raw as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > NAVIGATION_VERSION) throw new StoreReadError('FUTURE_VERSION', file)
    const parsed = navigationSchema.safeParse(raw)
    if (!parsed.success) throw new StoreReadError('UNREADABLE', file, 'unexpected format')
    return parsed.data
  }
  return {
    file,
    read,
    update(op) {
      const next = applyNavigationOp(read(), op)
      writeFileAtomic(file, JSON.stringify(next, null, 2))
      return next
    },
  }
}
