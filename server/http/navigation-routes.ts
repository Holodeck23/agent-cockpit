import type { IncomingMessage, ServerResponse } from 'node:http'
import { realpathSync, statSync } from 'node:fs'
import { scanLibrary, type Library, type LibraryScan } from '../projects/libraries.ts'
import { buildMap, type ProjectMap } from '../projects/map.ts'
import { NavigationError, navigationOpSchema, type NavigationOp, type NavigationStore } from '../projects/navigation.ts'
import type { ProjectStore } from '../projects/store.ts'
import type { ThreadSummary } from '../threads/types.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

// GET /api/map and POST /api/navigation (projects-area Move 3). Library scans are cached for a
// minute and refreshed on `?refresh=1` (the page asks when the window regains focus); a request
// never starts a scan of its own while a fresh one is cached.

export const SCAN_TTL_MS = 60_000

export interface MapServiceDeps {
  readonly navigation: NavigationStore
  readonly projects: Pick<ProjectStore, 'list'>
  readonly summaries: () => readonly ThreadSummary[]
  readonly scan?: (library: Library, others: readonly string[], known: readonly string[]) => LibraryScan
  readonly now?: () => number
  readonly realpath?: (path: string) => string
}

export interface MapService {
  map(refresh?: boolean): ProjectMap
  apply(op: NavigationOp): ProjectMap
}

export function createMapService(deps: MapServiceDeps): MapService {
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p))
  const scan = deps.scan ?? ((library, others, known) => scanLibrary(library, others, undefined, known))
  const now = deps.now ?? Date.now
  let cache: { key: string; at: number; scans: LibraryScan[] } | undefined

  const scans = (refresh: boolean): LibraryScan[] => {
    const nav = deps.navigation.read()
    const known = deps.projects.list({ includeHidden: true }).map((p) => p.path)
    const key = JSON.stringify(nav.libraries.map((l) => l.root))
    if (!refresh && cache && cache.key === key && now() - cache.at < SCAN_TTL_MS) return cache.scans
    const roots = nav.libraries.map((l) => l.root)
    const fresh = nav.libraries.flatMap((l) => {
      try { return [scan(l, roots.filter((r) => r !== l.root), known)] }
      catch { return [{ root: l.root, areas: [], truncated: false }] } // a library that went missing shows empty
    })
    cache = { key, at: now(), scans: fresh }
    return fresh
  }
  const map = (refresh = false): ProjectMap => buildMap({
    navigation: deps.navigation.read(),
    scans: scans(refresh),
    known: deps.projects.list({ includeHidden: true }),
    summaries: deps.summaries(),
    realpath,
  })
  const resolveFolder = (path: string): string => {
    let real: string
    try { real = realpath(path) } catch { throw new HttpError(400, 'That folder does not exist') }
    if (!statSync(real).isDirectory()) throw new HttpError(400, 'Choose a folder, not a file')
    return real
  }
  const realOr = (path: string): string => { try { return realpath(path) } catch { return path } }

  return {
    map,
    apply(op) {
      const resolved: NavigationOp = op.op === 'addLibrary' ? { ...op, root: resolveFolder(op.root) }
        : op.op === 'removeLibrary' || op.op === 'setLibraryPrivate' ? { ...op, root: realOr(op.root) }
        : op.op === 'moveProject' || op.op === 'renameProject' || op.op === 'setProjectPrivate' ? { ...op, path: realOr(op.path) }
        : op
      const areaRef = op.op === 'moveProject' ? op.areaId : 'id' in op ? op.id : null
      const refs = op.op === 'reorderAreas' ? op.ids : areaRef !== null ? [areaRef] : []
      if (refs.length > 0) {
        const ids = new Set(map().areas.map((a) => a.id))
        if (refs.some((r) => !ids.has(r))) throw new HttpError(404, 'Unknown area')
      }
      try { deps.navigation.update(resolved) } catch (error) {
        if (error instanceof NavigationError) throw new HttpError(400, error.message)
        throw error
      }
      return map(op.op === 'addLibrary' || op.op === 'removeLibrary')
    },
  }
}

/** Handles /api/map and /api/navigation; returns false for any other path. */
export async function handleNavigationRoute(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], service: MapService, viaPhone: boolean): Promise<boolean> {
  const method = req.method ?? 'GET'
  if (parts[1] === 'map' && parts.length === 2 && method === 'GET') {
    if (viaPhone) throw new HttpError(403, 'The Map is only available on the Mac')
    sendJson(res, 200, { data: service.map(url.searchParams.get('refresh') === '1') })
    return true
  }
  if (parts[1] === 'navigation' && parts.length === 2 && method === 'POST') {
    if (viaPhone) throw new HttpError(403, 'Projects can only be arranged on the Mac')
    sendJson(res, 200, { data: service.apply(parseBody(navigationOpSchema, await readJson(req))) })
    return true
  }
  return false
}
