import type { ThreadSummary } from '../threads/types.ts'
import { isInside, type Layer, type LibraryProject, type LibraryScan } from './libraries.ts'
import type { Navigation } from './navigation.ts'
import type { Project, ProjectColor } from './store.ts'

// The Map (GET /api/map): library scans + the projects Cockpit already knows + the person's
// arrangement (navigation.json) + live status, as one tree of areas and projects. Pure: the caller
// supplies the scans, the lists and a realpath function.

export const OTHER_AREA_ID = 'known'

export interface MapProject {
  /** Real path: the key for placement, names and Mac only. */
  readonly path: string
  /** The path to open: the one Cockpit already knows it by, else the real path. */
  readonly openPath: string
  readonly name: string
  readonly children: readonly MapProject[]
  readonly layers: readonly Layer[]
  readonly lastChangedAt?: string
  readonly lastActiveAt?: string
  readonly known: boolean
  readonly pinned: boolean
  readonly color?: ProjectColor
  readonly working: number
  readonly needsYou: number
  readonly private: boolean
}

export interface MapArea {
  readonly id: string
  readonly name: string
  /** The library the area came from; absent for areas the person made and "Other projects". */
  readonly library?: string
  /** The area's folder (real path), for areas proposed from a library. */
  readonly root?: string
  readonly private: boolean
  readonly shelf: boolean
  readonly hidden: boolean
  readonly collapsed: boolean
  readonly custom: boolean
  readonly projects: readonly MapProject[]
}

export interface ProjectMap {
  readonly libraries: ReadonlyArray<{ readonly root: string; readonly private: boolean; readonly truncated: boolean }>
  readonly areas: readonly MapArea[]
}

export interface MapInput {
  readonly navigation: Navigation
  /** One scan per library, in the navigation's library order. */
  readonly scans: readonly LibraryScan[]
  /** projects.json, removed projects included (they stay off the Map). */
  readonly known: readonly Project[]
  readonly summaries: readonly ThreadSummary[]
  readonly realpath: (path: string) => string
}

const isWorking = (s: ThreadSummary): boolean => s.status === 'starting' || s.status === 'working'
const needsYou = (s: ThreadSummary): boolean => !s.meta.completed && (s.status === 'needs_input' || (Boolean(s.awaiting) && !isWorking(s)))
const newest = (a: string | undefined, b: string | undefined): string | undefined => (!a ? b : !b ? a : a > b ? a : b)

interface Status { working: number; needsYou: number; lastActiveAt?: string }

export function buildMap({ navigation, scans, known, summaries, realpath }: MapInput): ProjectMap {
  const real = (p: string): string => { try { return realpath(p) } catch { return p } }
  const knownByReal = new Map(known.filter((p) => !p.hidden).map((p) => [real(p.path), p]))
  const removed = new Set(known.filter((p) => p.hidden).map((p) => real(p.path)))
  const status = new Map<string, Status>()
  for (const s of summaries) {
    const key = real(s.meta.projectPath)
    const prev = status.get(key) ?? { working: 0, needsYou: 0 }
    status.set(key, {
      working: prev.working + (isWorking(s) ? 1 : 0),
      needsYou: prev.needsYou + (needsYou(s) ? 1 : 0),
      lastActiveAt: newest(prev.lastActiveAt, s.lastActivityAt),
    })
  }
  const privateLibraries = navigation.libraries.filter((l) => l.private).map((l) => real(l.root))
  const privateProjects = new Set(navigation.privateProjects)
  const navArea = new Map(navigation.areas.map((a) => [a.id, a]))

  const toProject = (p: LibraryProject | { path: string; name: string; children: readonly LibraryProject[]; layers: readonly Layer[]; lastChangedAt?: string }): MapProject | undefined => {
    if (removed.has(p.path)) return undefined
    const k = knownByReal.get(p.path)
    const st = status.get(p.path)
    return {
      path: p.path,
      openPath: k?.path ?? p.path,
      name: navigation.names[p.path] ?? (k && k.name !== folderOf(k.path) ? k.name : p.name),
      children: p.children.flatMap((c) => toProject(c) ?? []),
      layers: p.layers,
      ...(p.lastChangedAt ? { lastChangedAt: p.lastChangedAt } : {}),
      ...(st?.lastActiveAt ?? k?.lastOpenedAt ? { lastActiveAt: newest(st?.lastActiveAt, k?.lastOpenedAt) } : {}),
      known: k !== undefined,
      pinned: k?.pinned === true,
      ...(k ? { color: k.color } : {}),
      working: st?.working ?? 0,
      needsYou: st?.needsYou ?? 0,
      private: false,
    }
  }

  // 1. Areas proposed by each library.
  type Draft = { id: string; name: string; library?: string; root?: string; private: boolean; shelf: boolean; custom: boolean; order: number; projects: MapProject[] }
  let drafts: Draft[] = scans.flatMap((scan, si) => {
    const lib = navigation.libraries[si]
    return scan.areas.map((a, ai): Draft => ({
      id: a.id, name: a.name, library: lib?.root ?? scan.root, root: a.root, private: a.private, shelf: a.shelf, custom: false,
      order: 10_000 + si * 1_000 + ai, projects: a.projects.flatMap((p) => toProject(p) ?? []),
    }))
  })
  const listed = new Set<string>()
  const walk = (ps: readonly MapProject[]): void => ps.forEach((p) => { listed.add(p.path); walk(p.children) })
  drafts.forEach((d) => walk(d.projects))

  // 2. Projects Cockpit knows that no library lists.
  const others = [...knownByReal.entries()].filter(([path]) => !listed.has(path))
    .flatMap(([path, k]) => toProject({ path, name: k.name, children: [], layers: [] }) ?? [])
  if (others.length > 0) {
    drafts.push({ id: OTHER_AREA_ID, name: scans.length > 0 ? 'Other projects' : 'Projects', private: false, shelf: false, custom: false, order: 90_000, projects: others })
    others.forEach((p) => listed.add(p.path))
  }

  // 3. Areas the person made.
  for (const a of navigation.areas.filter((x) => x.custom && x.name)) {
    drafts.push({ id: a.id, name: a.name!, private: false, shelf: false, custom: true, order: 50_000, projects: [] })
  }

  // 4. Placement: a project the person moved leaves its proposed spot and joins the chosen area.
  for (const [path, areaId] of Object.entries(navigation.placement)) {
    if (!drafts.some((d) => d.id === areaId)) continue
    let moved: MapProject | undefined
    const pull = (ps: readonly MapProject[]): MapProject[] => ps.flatMap((p) => {
      if (p.path === path) { moved = p; return [] }
      return [{ ...p, children: pull(p.children) }]
    })
    drafts = drafts.map((d) => ({ ...d, projects: pull(d.projects) }))
    const found = moved
    if (found) drafts = drafts.map((d) => (d.id === areaId ? { ...d, projects: [...d.projects, found] } : d))
  }

  // 5. The person's names, order, hiding, Mac only and folding; privacy flows down and never lifts.
  const areas = drafts.map((d): MapArea & { order: number } => {
    const n = navArea.get(d.id)
    const areaPrivate = d.private || n?.private === true
    const mark = (p: MapProject, inherited: boolean): MapProject => {
      const priv = inherited || privateProjects.has(p.path) || privateLibraries.some((root) => isInside(p.path, root))
      return { ...p, private: priv, children: p.children.map((c) => mark(c, priv)) }
    }
    return {
      id: d.id,
      name: n?.name ?? d.name,
      ...(d.library ? { library: d.library } : {}),
      ...(d.root ? { root: d.root } : {}),
      private: areaPrivate,
      shelf: d.shelf,
      hidden: n?.hidden === true,
      collapsed: navigation.collapsed.includes(d.id) || (d.shelf && n?.open !== true),
      custom: d.custom,
      order: n?.order ?? d.order,
      projects: d.projects.map((p) => mark(p, areaPrivate)),
    }
  }).sort((a, b) => a.order - b.order)

  return {
    libraries: navigation.libraries.map((l, i) => ({ root: l.root, private: l.private === true, truncated: scans[i]?.truncated === true })),
    areas: areas.map(({ order: _order, ...a }) => a),
  }
}

function folderOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Every project in the map, depth first. */
export function mapProjects(map: ProjectMap): MapProject[] {
  const out: MapProject[] = []
  const walk = (ps: readonly MapProject[]): void => ps.forEach((p) => { out.push(p); walk(p.children) })
  map.areas.forEach((a) => walk(a.projects))
  return out
}
