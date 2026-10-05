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
