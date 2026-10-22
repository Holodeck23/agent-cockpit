import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isRemoteRoute } from '../server/remote/guard.ts'
import { createMapService } from '../server/http/navigation-routes.ts'
import { scanLibrary, type LibraryScan } from '../server/projects/libraries.ts'
import { buildMap, mapProjects, OTHER_AREA_ID, type MapInput } from '../server/projects/map.ts'
import { applyNavigationOp, createNavigationStore, emptyNavigation, NavigationError, type Navigation } from '../server/projects/navigation.ts'
import { createProjectStore, type Project } from '../server/projects/store.ts'
import { StoreReadError } from '../server/state/read-error.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import type { ThreadSummary } from '../server/threads/types.ts'

const tmp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const dir = (...parts: string[]): string => { const p = join(...parts); mkdirSync(p, { recursive: true }); return p }
const ids = (() => { let n = 0; return () => `n_test${(n += 1)}` })()

describe('navigation store', () => {
  it('starts empty without writing a file', () => {
    const root = tmp('cockpit-nav-')
    expect(createNavigationStore(root).read()).toEqual(emptyNavigation())
    expect(readdirSync(root)).toEqual([])
  })

  it('an unreadable or newer file fails visibly and is never overwritten', () => {
    for (const [bad, code] of [['{oops', 'UNREADABLE'], ['{"version":1,"libraries":"x"}', 'UNREADABLE'], ['{"version":2}', 'FUTURE_VERSION']] as const) {
      const root = tmp('cockpit-nav-')
      writeFileSync(join(root, 'navigation.json'), bad)
      const store = createNavigationStore(root)
      expect(() => store.read()).toThrow(StoreReadError)
      try { store.read() } catch (error) { expect((error as StoreReadError).code).toBe(code) }
      expect(() => store.update({ op: 'createArea', name: 'X' })).toThrow(StoreReadError)
      expect(readFileSync(join(root, 'navigation.json'), 'utf8')).toBe(bad)
    }
  })

  it('keeps keys it does not know, at every level, so a newer build\'s fields survive', () => {
    const root = tmp('cockpit-nav-')
    writeFileSync(join(root, 'navigation.json'), JSON.stringify({
      version: 1, future: { a: 1 }, libraries: [{ root: '/lib', colourScheme: 'x' }], areas: [{ id: 'a1', name: 'One', icon: 'star' }],
      placement: {}, names: {}, collapsed: [],
    }))
    const store = createNavigationStore(root)
    store.update({ op: 'renameArea', id: 'a1', name: 'Uno' })
    store.update({ op: 'setLibraryPrivate', root: '/lib', private: true })
    const saved = JSON.parse(readFileSync(join(root, 'navigation.json'), 'utf8'))
    expect(saved.future).toEqual({ a: 1 })
    expect(saved.libraries[0]).toEqual({ root: '/lib', colourScheme: 'x', private: true })
    expect(saved.areas[0]).toMatchObject({ id: 'a1', name: 'Uno', icon: 'star' })
  })

  it('applies every change without mutating its input', () => {
    let nav: Navigation = emptyNavigation()
    const apply = (op: Parameters<typeof applyNavigationOp>[1]): Navigation => {
      const before = JSON.stringify(nav)
      const next = applyNavigationOp(nav, op, ids)
      expect(JSON.stringify(nav)).toBe(before)
      nav = next
      return next
    }
    apply({ op: 'addLibrary', root: '/code' })
    apply({ op: 'addLibrary', root: '/notes', private: true })
    expect(nav.libraries).toEqual([{ root: '/code' }, { root: '/notes', private: true }])
    apply({ op: 'setLibraryPrivate', root: '/code', private: true })
    expect(nav.libraries[0]?.private).toBe(true)
    apply({ op: 'removeLibrary', root: '/code' })
    expect(nav.libraries.map((l) => l.root)).toEqual(['/notes'])

    apply({ op: 'createArea', name: 'Clients' })
    const created = nav.areas[0]!
    expect(created).toMatchObject({ name: 'Clients', custom: true, order: 1 })
    apply({ op: 'renameArea', id: created.id, name: 'Customers' })
    apply({ op: 'hideArea', id: 'a_scanned', hidden: true })
    apply({ op: 'setAreaPrivate', id: created.id, private: true })
    expect(nav.areas.find((a) => a.id === created.id)).toMatchObject({ name: 'Customers', private: true })
    expect(nav.areas.find((a) => a.id === 'a_scanned')).toMatchObject({ hidden: true, order: 2 })
    apply({ op: 'reorderAreas', ids: ['a_scanned'] })
    expect(nav.areas.map((a) => [a.id, a.order])).toEqual([[created.id, 2], ['a_scanned', 1]])

    apply({ op: 'setCollapsed', id: 'a_shelf', collapsed: false })
    expect(nav.collapsed).toEqual([])
    expect(nav.areas.find((a) => a.id === 'a_shelf')?.open).toBe(true)
    apply({ op: 'setCollapsed', id: 'a_x', collapsed: true })
    expect(nav.collapsed).toEqual(['a_x'])

    apply({ op: 'moveProject', path: '/notes/p', areaId: created.id })
    expect(nav.placement).toEqual({ '/notes/p': created.id })
    apply({ op: 'moveProject', path: '/notes/p', areaId: null })
    expect(nav.placement).toEqual({})
    apply({ op: 'renameProject', path: '/notes/p', name: 'Pea' })
    expect(nav.names).toEqual({ '/notes/p': 'Pea' })
    apply({ op: 'renameProject', path: '/notes/p', name: null })
    expect(nav.names).toEqual({})
    apply({ op: 'setProjectPrivate', path: '/notes/p', private: true })
    apply({ op: 'setProjectPrivate', path: '/notes/p', private: true })
    expect(nav.privateProjects).toEqual(['/notes/p'])
  })

  it('refuses a library that overlaps one already added, and relative paths', () => {
    const nav = applyNavigationOp(emptyNavigation(), { op: 'addLibrary', root: '/code' })
    expect(() => applyNavigationOp(nav, { op: 'addLibrary', root: '/code' })).toThrow(/already a library/)
    expect(() => applyNavigationOp(nav, { op: 'addLibrary', root: '/code/apps' })).toThrow(NavigationError)
    expect(() => applyNavigationOp(nav, { op: 'addLibrary', root: '/' })).toThrow(/overlaps/)
    expect(() => applyNavigationOp(nav, { op: 'addLibrary', root: 'relative' })).toThrow(/full path/)
    expect(applyNavigationOp(nav, { op: 'addLibrary', root: '/codex' }).libraries).toHaveLength(2)
  })
})

const project = (path: string, extra: Partial<Project> = {}): Project => ({ path, name: path.split('/').pop()!, color: 'blue', pinned: false, lastOpenedAt: '2026-10-01T10:00:00.000Z', ...extra })
const summary = (projectPath: string, status: ThreadSummary['status'], extra: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({ meta: { projectPath, completed: false } as ThreadSummary['meta'], status, preview: '', messageCount: 1, lastActivityAt: '2026-10-11T09:00:00.000Z', ...extra })

describe('the map', () => {
  /** /code with areas apps (tidepool, lantern) and parked (orchard); /home private with area table (budget). */
  const fixture = () => {
    const code = tmp('cockpit-map-code-'), home = tmp('cockpit-map-home-')
    dir(code, 'apps', 'tidepool', '.git'); dir(code, 'apps', 'lantern'); dir(code, 'parked', 'orchard')
    dir(home, 'table', 'budget')
    let nav = applyNavigationOp(emptyNavigation(), { op: 'addLibrary', root: code })
    nav = applyNavigationOp(nav, { op: 'addLibrary', root: home, private: true })
    const scans = (n: Navigation): LibraryScan[] => n.libraries.map((l) => scanLibrary(l, n.libraries.map((x) => x.root).filter((r) => r !== l.root)))
    const input = (n: Navigation, extra: Partial<MapInput> = {}): MapInput => ({ navigation: n, scans: scans(n), known: [], summaries: [], realpath: realpathSync, ...extra })
    return { code, home, nav, input }
  }

  it('lists library areas in order, with shelves collapsed and private libraries private', () => {
    const { nav, input } = fixture()
    const map = buildMap(input(nav))
    expect(map.areas.map((a) => [a.name, a.shelf, a.collapsed, a.private])).toEqual([
      ['apps', false, false, false], ['parked', true, true, false], ['table', false, false, true],
    ])
    expect(mapProjects(map).find((p) => p.name === 'budget')?.private).toBe(true)
    expect(mapProjects(map).find((p) => p.name === 'tidepool')?.private).toBe(false)
  })

  it('merges known projects by real path, keeps removed ones off, and lists the rest under Other projects', () => {
    const { code, nav, input } = fixture()
    const elsewhere = tmp('cockpit-map-else-')
    const link = join(tmp('cockpit-map-link-'), 'tide')
    symlinkSync(join(code, 'apps', 'tidepool'), link)
    const known = [project(link, { pinned: true, pinOrder: 1, color: 'pink', name: 'Tide Pool' }), project(join(code, 'apps', 'lantern'), { hidden: true }), project(elsewhere)]
    const map = buildMap(input(nav, { known }))
    const tide = mapProjects(map).find((p) => p.path === join(code, 'apps', 'tidepool'))!
    expect(tide).toMatchObject({ name: 'Tide Pool', openPath: link, pinned: true, color: 'pink', known: true })
    expect(mapProjects(map).some((p) => p.name === 'lantern')).toBe(false)
    expect(map.areas.find((a) => a.id === OTHER_AREA_ID)?.projects.map((p) => p.path)).toEqual([elsewhere])
    const paths = mapProjects(map).map((p) => p.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('counts working and needs-you per project, by real path', () => {
    const { code, nav, input } = fixture()
    const p = join(code, 'apps', 'tidepool')
    const summaries = [summary(p, 'working'), summary(p, 'needs_input'), summary(p, 'idle', { awaiting: 'question', lastActivityAt: '2026-10-12T08:00:00.000Z' }),
      summary(p, 'idle', { awaiting: 'question', meta: { projectPath: p, completed: true } as ThreadSummary['meta'] }), summary(p, 'idle')]
    const tide = mapProjects(buildMap(input(nav, { summaries }))).find((x) => x.path === p)!
    expect([tide.working, tide.needsYou, tide.lastActiveAt]).toEqual([1, 2, '2026-10-12T08:00:00.000Z'])
  })

  it('applies the person\'s arrangement: new area, move, rename, order, hide, fold', () => {
    const { code, nav: base, input } = fixture()
    const first = buildMap(input(base))
    const apps = first.areas.find((a) => a.name === 'apps')!, parked = first.areas.find((a) => a.name === 'parked')!
    let nav = applyNavigationOp(base, { op: 'createArea', name: 'Clients' }, () => 'n_clients')
    nav = applyNavigationOp(nav, { op: 'moveProject', path: join(code, 'apps', 'lantern'), areaId: 'n_clients' })
    nav = applyNavigationOp(nav, { op: 'renameProject', path: join(code, 'apps', 'tidepool'), name: 'Tidepool' })
    nav = applyNavigationOp(nav, { op: 'renameArea', id: apps.id, name: 'Apps' })
    nav = applyNavigationOp(nav, { op: 'reorderAreas', ids: ['n_clients', apps.id] })
    nav = applyNavigationOp(nav, { op: 'setCollapsed', id: parked.id, collapsed: false })
    nav = applyNavigationOp(nav, { op: 'hideArea', id: apps.id, hidden: true })
    const map = buildMap(input(nav))
    expect(map.areas.slice(0, 2).map((a) => [a.name, a.hidden])).toEqual([['Clients', false], ['Apps', true]])
    expect(map.areas[0]!.projects.map((p) => p.name)).toEqual(['lantern'])
    expect(map.areas[1]!.projects.map((p) => p.name)).toEqual(['Tidepool'])
    expect(map.areas.find((a) => a.id === parked.id)?.collapsed).toBe(false)
  })

  it('moving a private project into a shared area keeps it private; marking one project or area Mac only flows down', () => {
    const { code, home, nav: base, input } = fixture()
    const apps = buildMap(input(base)).areas.find((a) => a.name === 'apps')!
    let nav = applyNavigationOp(base, { op: 'moveProject', path: join(home, 'table', 'budget'), areaId: apps.id })
    nav = applyNavigationOp(nav, { op: 'setProjectPrivate', path: join(code, 'apps', 'lantern'), private: true })
    let all = mapProjects(buildMap(input(nav)))
    expect(all.find((p) => p.name === 'budget')?.private).toBe(true)
    expect(all.find((p) => p.name === 'lantern')?.private).toBe(true)
    expect(all.find((p) => p.name === 'tidepool')?.private).toBe(false)
    nav = applyNavigationOp(nav, { op: 'setAreaPrivate', id: apps.id, private: true })
    all = mapProjects(buildMap(input(nav)))
    expect(all.find((p) => p.name === 'tidepool')?.private).toBe(true)
  })

  it('with no libraries, known projects are listed under Projects', () => {
    const p = tmp('cockpit-map-solo-')
    const map = buildMap({ navigation: emptyNavigation(), scans: [], known: [project(p)], summaries: [], realpath: realpathSync })
    expect(map.areas.map((a) => [a.id, a.name, a.projects.length])).toEqual([[OTHER_AREA_ID, 'Projects', 1]])
  })
})

describe('map service', () => {
  it('caches scans for a minute and rescans on refresh or when libraries change', () => {
    const root = tmp('cockpit-svc-'), lib = tmp('cockpit-svc-lib-'), lib2 = tmp('cockpit-svc-lib2-')
    dir(lib, 'apps', 'one')
    let clock = 0, scans = 0
    const service = createMapService({
      navigation: createNavigationStore(root), projects: createProjectStore(root), summaries: () => [], now: () => clock,
      scan: (l, others, known) => { scans += 1; return scanLibrary(l, others, undefined, known) },
    })
    service.apply({ op: 'addLibrary', root: lib })
    expect(scans).toBe(1)
    service.map(); service.map()
    expect(scans).toBe(1)
    clock = 61_000
    service.map()
    expect(scans).toBe(2)
    service.map(true)
    expect(scans).toBe(3)
    service.apply({ op: 'addLibrary', root: lib2 })
    expect(scans).toBe(5)
  })

  it('refuses unknown areas and folders that do not exist; resolves a library to its real path', () => {
    const root = tmp('cockpit-svc-'), lib = tmp('cockpit-svc-lib-')
    dir(lib, 'apps', 'one')
    const link = join(tmp('cockpit-svc-link-'), 'lib')
    symlinkSync(lib, link)
    const service = createMapService({ navigation: createNavigationStore(root), projects: createProjectStore(root), summaries: () => [] })
    expect(service.apply({ op: 'addLibrary', root: link }).libraries.map((l) => l.root)).toEqual([lib])
    expect(() => service.apply({ op: 'addLibrary', root: join(lib, 'nope') })).toThrow(/does not exist/)
    expect(() => service.apply({ op: 'moveProject', path: join(lib, 'apps', 'one'), areaId: 'a_nope' })).toThrow(/Unknown area/)
    expect(() => service.apply({ op: 'reorderAreas', ids: ['a_nope'] })).toThrow(/Unknown area/)
    expect(() => service.apply({ op: 'addLibrary', root: join(lib, 'apps') })).toThrow(/overlaps/)
  })
})

describe('map and navigation routes', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('arranges projects without touching projects.json or the library folders', async () => {
    const state = tmp('cockpit-nav-routes-'), lib = tmp('cockpit-nav-routes-lib-')
    dir(lib, 'apps', 'tidepool', '.git'); dir(lib, 'apps', 'lantern')
    running = await startServer({ port: 0, webDist: state, stateRoot: state })
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    await call('/api/projects', { path: join(lib, 'apps', 'tidepool'), pinned: true })
    const projectsBefore = readFileSync(join(state, 'projects.json'), 'utf8')
    const listing = (): string[] => readdirSync(lib, { recursive: true }).map(String).sort()
    const disk = listing()

    expect((await call('/api/map')).body.data.areas).toEqual([expect.objectContaining({ name: 'Projects' })])
    const added = await call('/api/navigation', { op: 'addLibrary', root: lib })
    expect(added.status).toBe(200)
    const apps = added.body.data.areas.find((a: { name: string }) => a.name === 'apps')
    expect(apps.projects.map((p: { name: string; pinned: boolean }) => [p.name, p.pinned])).toEqual([['lantern', false], ['tidepool', true]])
    const created = await call('/api/navigation', { op: 'createArea', name: 'Clients' })
    const clients = created.body.data.areas.find((a: { name: string }) => a.name === 'Clients')
    const moved = await call('/api/navigation', { op: 'moveProject', path: join(lib, 'apps', 'lantern'), areaId: clients.id })
    expect(moved.body.data.areas.find((a: { id: string }) => a.id === clients.id).projects[0].name).toBe('lantern')
    await call('/api/navigation', { op: 'renameArea', id: apps.id, name: 'Apps' })
    await call('/api/navigation', { op: 'setAreaPrivate', id: apps.id, private: true })
    await call('/api/navigation', { op: 'renameProject', path: join(lib, 'apps', 'tidepool'), name: 'Tide' })
    expect((await call('/api/navigation', { op: 'nope' })).status).toBe(400)
    expect((await call('/api/navigation', { op: 'renameArea', id: 'a_missing', name: 'x' })).status).toBe(404)

    const after = (await call('/api/map?refresh=1')).body.data
    expect(after.areas.find((a: { id: string }) => a.id === apps.id)).toMatchObject({ name: 'Apps', private: true })
    expect(readFileSync(join(state, 'projects.json'), 'utf8')).toBe(projectsBefore)
    expect(listing()).toEqual(disk)
    expect(JSON.parse(readFileSync(join(state, 'navigation.json'), 'utf8')).libraries).toEqual([{ root: lib }])
  })

  it('keeps the Map and arranging off the phone', () => {
    expect(isRemoteRoute('GET', '/api/map')).toBe(false)
    expect(isRemoteRoute('POST', '/api/navigation')).toBe(false)
  })
})
