import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { colorFor, createProjectStore, PROJECT_COLORS } from '../server/projects/store.ts'

const newRoot = (): string => mkdtempSync(join(tmpdir(), 'cockpit-projects-'))

describe('project store', () => {
  it('starts empty and survives a corrupt file', () => {
    const root = newRoot()
    expect(createProjectStore(root).list()).toEqual([])
    writeFileSync(join(root, 'projects.json'), '{not json')
    expect(createProjectStore(root).list()).toEqual([])
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
