import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectStore } from '../../server/projects/store.ts'

// u12-1: fresh() names a new project after its folder with no length cap, but projectSchema caps
// name at 80 and read() rejects the WHOLE file when any entry fails. A folder whose basename is
// over 80 characters must still be a usable project and must not make projects.json unreadable.

const newRoot = (): string => mkdtempSync(join(tmpdir(), 'cockpit-u12-1-'))
const longName = 'client-proposal-for-the-new-website-redesign-and-brand-refresh-phase-two-final-v3-approved'

describe('u12-1: long folder names', () => {
  it('has a basename over 80 characters (precondition)', () => {
    expect(longName.length).toBeGreaterThan(80)
  })

  it('ensure() with a long basename leaves the store readable, alongside the other projects', () => {
    const store = createProjectStore(newRoot())
    store.open('/work/bakery', { pinned: true })
    store.ensure([{ path: `/work/${longName}`, at: '2026-09-01T10:00:00.000Z' }])

    const list = store.list()
    expect(list.map((p) => p.path).sort()).toEqual(['/work/bakery', `/work/${longName}`].sort())
    const long = list.find((p) => p.path === `/work/${longName}`)
    expect(long?.name.length).toBeGreaterThan(0)
    expect(long?.name.length).toBeLessThanOrEqual(80)
  })

  it('open() of a real folder with a long basename leaves the store readable for later calls', () => {
    const root = newRoot()
    const folder = join(mkdtempSync(join(tmpdir(), 'cockpit-u12-1-dir-')), longName)
    mkdirSync(folder)
    const store = createProjectStore(root)

    store.open(folder, { pinned: true })

    // A fresh store over the same file (like the next request after a restart) must still read it.
    const again = createProjectStore(root)
    expect(() => again.list()).not.toThrow()
    expect(() => again.open('/work/other')).not.toThrow()
    expect(again.list().some((p) => p.path === folder)).toBe(true)
  })
})
