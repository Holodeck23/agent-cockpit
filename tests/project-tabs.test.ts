import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectStore } from '../server/projects/store.ts'
import { dropIndex, moveTab, nextAfterClose, tabOrder } from '../web/src/project-tabs.ts'
import { DRAG_THRESHOLD_PX } from '../web/src/useTabDrag.ts'

const newRoot = (): string => mkdtempSync(join(tmpdir(), 'cockpit-tabs-'))

describe('tab order helpers', () => {
  it('moveTab moves one item and never mutates', () => {
    const items = ['a', 'b', 'c', 'd']
    expect(moveTab(items, 2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveTab(items, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveTab(items, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveTab(items, 1, 1)).toEqual(items)
    expect(moveTab(items, 5, 0)).toEqual(items)
    expect(items).toEqual(['a', 'b', 'c', 'd'])
  })

  it('dropIndex counts the other tabs whose middle is left of the pointer', () => {
    const others = [{ left: 0, width: 100 }, { left: 100, width: 100 }]
    expect(dropIndex(others, 10)).toBe(0)
    expect(dropIndex(others, 60)).toBe(1)
    expect(dropIndex(others, 160)).toBe(2)
    expect(dropIndex([], 50)).toBe(0)
  })

  it('a drag of the third tab to the far left puts it first', () => {
    const pinned = ['one', 'two', 'three']
    const others = [{ left: 0, width: 100 }, { left: 100, width: 100 }]
    expect(moveTab(pinned, 2, dropIndex(others, 5))).toEqual(['three', 'one', 'two'])
  })

  it('nextAfterClose picks the tab after, else before, else none', () => {
    const tabs = [{ path: '/a' }, { path: '/b' }, { path: '/c' }]
    expect(nextAfterClose(tabs, '/a')?.path).toBe('/b')
    expect(nextAfterClose(tabs, '/c')?.path).toBe('/b')
    expect(nextAfterClose([{ path: '/a' }], '/a')).toBeUndefined()
    expect(nextAfterClose(tabs, '/x')).toBeUndefined()
  })

  it('a click is a click until the pointer moves 4 px', () => {
    expect(DRAG_THRESHOLD_PX).toBe(4)
  })
})

describe('reordering pinned tabs', () => {
  it('rewrites pinOrder only, and tabOrder follows it', () => {
    const root = newRoot()
    const store = createProjectStore(root)
    for (const name of ['one', 'two', 'three']) store.open(`/work/${name}`, { pinned: true })
    store.open('/work/loose')
    const before = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8')) as Array<Record<string, unknown>>
    store.reorderPins(['/work/three', '/work/one', '/work/two'])
    const after = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(after.map((p) => { const { pinOrder: _, ...rest } = p; return rest })).toEqual(before.map((p) => { const { pinOrder: _, ...rest } = p; return rest }))
    expect(tabOrder(store.list(), '/work/loose').map((p) => p.path)).toEqual(['/work/three', '/work/one', '/work/two', '/work/loose'])
  })

  it('pinned projects left out keep their order after the named ones', () => {
    const store = createProjectStore(newRoot())
    for (const name of ['one', 'two', 'three', 'four']) store.open(`/work/${name}`, { pinned: true })
    store.reorderPins(['/work/four'])
    expect(tabOrder(store.list(), undefined).map((p) => p.path)).toEqual(['/work/four', '/work/one', '/work/two', '/work/three'])
  })

  it('refuses unpinned, removed or unknown projects and writes nothing', () => {
    const root = newRoot()
    const store = createProjectStore(root)
    store.open('/work/one', { pinned: true })
    store.open('/work/two')
    const before = readFileSync(join(root, 'projects.json'), 'utf8')
    expect(() => store.reorderPins(['/work/two', '/work/one'])).toThrow(/pinned/)
    expect(() => store.reorderPins(['/nope'])).toThrow(/pinned/)
    expect(readFileSync(join(root, 'projects.json'), 'utf8')).toBe(before)
  })

  it('a new pin after a reorder goes last', () => {
    const store = createProjectStore(newRoot())
    for (const name of ['one', 'two']) store.open(`/work/${name}`, { pinned: true })
    store.reorderPins(['/work/two', '/work/one'])
    store.open('/work/three', { pinned: true })
    expect(tabOrder(store.list(), undefined).map((p) => p.path)).toEqual(['/work/two', '/work/one', '/work/three'])
  })
})
