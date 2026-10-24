import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { colorFor, createProjectStore, PROJECT_COLORS } from '../server/projects/store.ts'
import { StoreReadError } from '../server/state/read-error.ts'
import { tabOrder } from '../web/src/project-tabs.ts'

const newRoot = (): string => mkdtempSync(join(tmpdir(), 'cockpit-projects-'))

describe('project store', () => {
  it('starts empty; a corrupt file fails visibly and is never overwritten (ID-02)', () => {
    const root = newRoot()
    expect(createProjectStore(root).list()).toEqual([])
    for (const bad of ['{not json', '[{"path":"/a","name":"A","color":"blue","pinned":true,"lastOpenedAt":"x"},', '[{"path":"/a"}]']) {
      writeFileSync(join(root, 'projects.json'), bad)
      const store = createProjectStore(root)
      expect(() => store.list()).toThrow(StoreReadError)
      expect(() => store.open('/b')).toThrow(/preserved/)
      expect(() => store.ensure([{ path: '/c', at: '2026-09-01T10:00:00.000Z' }])).toThrow(StoreReadError)
      expect(readFileSync(join(root, 'projects.json'), 'utf8')).toBe(bad)
    }
  })

  it('registers folders from threads unpinned, dated by their latest thread', () => {
    const store = createProjectStore(newRoot())
    store.ensure([
      { path: '/work/bakery', at: '2026-09-01T10:00:00.000Z' },
      { path: '/work/sprout', at: '2026-09-02T10:00:00.000Z' },
      { path: '/work/bakery', at: '2026-09-03T10:00:00.000Z' },
      { path: 'relative/ignored', at: '2026-09-04T10:00:00.000Z' },
    ])
    expect(store.list().map((p) => [p.name, p.pinned, p.lastOpenedAt])).toEqual([
      ['bakery', false, '2026-09-03T10:00:00.000Z'],
      ['sprout', false, '2026-09-02T10:00:00.000Z'],
    ])
  })

  it('open() pins, renames and bumps a project to the front, and persists', () => {
    const root = newRoot()
    const store = createProjectStore(root)
    store.ensure([
      { path: '/work/bakery', at: '2026-09-01T10:00:00.000Z' },
      { path: '/work/sprout', at: '2026-09-02T10:00:00.000Z' },
    ])
    const opened = store.open('/work/bakery', { pinned: true, name: 'Bakery website' })
    expect(opened).toMatchObject({ path: '/work/bakery', name: 'Bakery website', pinned: true })
    const reloaded = createProjectStore(root).list()
    expect(reloaded[0]).toMatchObject({ path: '/work/bakery', pinned: true })
    expect(reloaded).toHaveLength(2)
  })

  it('ensure() never overwrites a known project', () => {
    const store = createProjectStore(newRoot())
    store.open('/work/sprout', { pinned: true, color: 'pink' })
    store.ensure([{ path: '/work/sprout', at: '2030-01-01T00:00:00.000Z' }])
    expect(store.list()[0]).toMatchObject({ pinned: true, color: 'pink' })
  })

  it('rejects relative paths', () => {
    expect(() => createProjectStore(newRoot()).open('work/sprout')).toThrow(/absolute/)
  })

  it('gives each folder a stable colour from the palette', () => {
    expect(colorFor('/work/sprout')).toBe(colorFor('/work/sprout'))
    expect(PROJECT_COLORS).toContain(colorFor('/any/where'))
  })
})

describe('project tabs in pin order', () => {
  it('numbers each new pin after the last; unpinning or removing clears it, re-pinning goes last', () => {
    const store = createProjectStore(newRoot())
    store.open('/work/zeta', { pinned: true })
    store.open('/work/alpha', { pinned: true })
    store.open('/work/mid', { pinned: true })
    const order = () => Object.fromEntries(store.list().map((p) => [p.name, p.pinOrder]))
    expect(order()).toEqual({ zeta: 1, alpha: 2, mid: 3 })
    store.open('/work/zeta', { name: 'Zeta site' })
    expect(order()).toMatchObject({ 'Zeta site': 1 })
    store.open('/work/zeta', { pinned: false })
    store.hide('/work/alpha')
    expect(Object.fromEntries(store.list({ includeHidden: true }).map((p) => [p.name, p.pinOrder]))).toEqual({ 'Zeta site': undefined, alpha: undefined, mid: 3 })
    store.open('/work/zeta', { pinned: true })
    expect(order()).toMatchObject({ 'Zeta site': 4 })
  })
  it('lists pins in that order: older pins without a number first by name, then the active unpinned one', () => {
    const p = (name: string, pinned: boolean, pinOrder?: number) => ({ path: `/w/${name}`, name, pinned, pinOrder })
    const all = [p('c', true, 5), p('old-b', true), p('a', true, 2), p('loose', false), p('old-a', true), p('other', false)]
    expect(tabOrder(all, '/w/loose').map((t) => t.name)).toEqual(['old-a', 'old-b', 'a', 'c', 'loose'])
    expect(tabOrder(all, '/w/a').map((t) => t.name)).toEqual(['old-a', 'old-b', 'a', 'c'])
  })
})

describe('pinned project files', () => {
  it('keeps them in pin order without counting as opening the project, drops duplicates and caps the list', () => {
    const store = createProjectStore(newRoot())
    const opened = store.open('/work/bakery').lastOpenedAt
    const next = store.setPinnedFiles('/work/bakery', ['src/app.ts', 'README.md', 'src/app.ts'])
    expect(next.pinnedFiles).toEqual(['src/app.ts', 'README.md'])
    expect(next.lastOpenedAt).toBe(opened)
    expect(store.setPinnedFiles('/work/bakery', Array.from({ length: 30 }, (_, i) => `f${i}.ts`)).pinnedFiles).toHaveLength(20)
    expect(store.setPinnedFiles('/work/bakery', []).pinnedFiles).toBeUndefined()
  })

  it('refuses paths outside the project and unknown projects', () => {
    const store = createProjectStore(newRoot())
    store.open('/work/bakery')
    expect(() => store.setPinnedFiles('/work/bakery', ['../secrets.txt'])).toThrow(/inside the project/)
    expect(() => store.setPinnedFiles('/work/bakery', ['/etc/hosts'])).toThrow(/inside the project/)
    expect(() => store.setPinnedFiles('/work/nowhere', ['a.ts'])).toThrow(/Unknown project/)
  })
})

describe('direct project tab controls', () => {
  it('persists ordering across reloads and preserves project metadata and hidden entries', () => {
    const root = newRoot()
    const store = createProjectStore(root)
    const a = store.open('/work/a', { pinned: true, instructions: 'Keep this', codexNetwork: true })
    store.open('/work/b', { pinned: true })
    store.open('/work/c', { pinned: true })
    store.open('/work/hidden', { pinned: true }); store.hide('/work/hidden')
    const hidden = store.list({ includeHidden: true }).find((p) => p.hidden)
    store.updateTab('/work/c', { before: '/work/a' })
    expect(tabOrder(createProjectStore(root).list(), undefined).map((p) => p.path)).toEqual(['/work/c', '/work/a', '/work/b'])
    store.updateTab('/work/c', { after: '/work/b' })
    expect(tabOrder(store.list(), undefined).map((p) => p.path)).toEqual(['/work/a', '/work/b', '/work/c'])
    store.updateTab('/work/a', { color: 'purple', pinned: false })
    expect(store.list().find((p) => p.path === a.path)).toEqual({ ...a, color: 'purple', pinned: false, pinOrder: undefined })
    expect(store.list({ includeHidden: true }).find((p) => p.hidden)).toEqual(hidden)
  })
  it('allows the active unpinned project to be moved, and an unpinned anchor to take its chosen position', () => {
    const store = createProjectStore(newRoot())
    store.open('/work/a', { pinned: true }); store.open('/work/b', { pinned: true }); store.open('/work/loose')
    store.updateTab('/work/loose', { before: '/work/b' })
    expect(tabOrder(store.list(), undefined).map((p) => p.name)).toEqual(['a', 'loose', 'b'])
    store.updateTab('/work/loose', { pinned: false })
    store.updateTab('/work/a', { after: '/work/loose' })
    expect(tabOrder(store.list(), undefined).map((p) => p.name)).toEqual(['b', 'loose', 'a'])
  })
  it('refuses unknown, hidden, malformed and ambiguous changes without writing', () => {
    const root = newRoot(), store = createProjectStore(root)
    store.open('/work/a', { pinned: true }); store.open('/work/hidden'); store.hide('/work/hidden')
    const before = readFileSync(join(root, 'projects.json'), 'utf8')
    for (const [path, patch] of [
      ['/work/missing', { pinned: true }], ['/work/hidden', { color: 'blue' }],
      ['/work/a', { before: '/work/hidden' }], ['/work/a', { before: '/work/missing' }],
      ['/work/a', { before: null, after: '/work/a' }], ['/work/a', { before: null, pinned: false }],
      ['/work/a', { color: 'invalid' }], ['/work/a', {}], ['/work/a', { instructions: 'overwrite' }],
    ] as const) {
      expect(() => store.updateTab(path, patch as never)).toThrow()
      expect(readFileSync(join(root, 'projects.json'), 'utf8')).toBe(before)
    }
  })
})
