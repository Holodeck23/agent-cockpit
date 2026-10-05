import { describe, expect, it } from 'vitest'
import { evictions, RESIDENCY, roomForPage, type ResidentPage } from '../electron/browser-policy.ts'

// W9-10: at most four idle loaded pages, idle ones unloaded after five minutes, eight in all;
// a page that is shown, in use by an agent, downloading or holding unsaved input is never unloaded.

const MIN = 60_000
const page = (key: string, minutesAgo: number, pinned = false): ResidentPage => ({ key, lastUsed: 100 * MIN - minutesAgo * MIN, pinned })
const now = 100 * MIN

describe('browser page residency', () => {
  it('unloads idle pages after five minutes, never a pinned one', () => {
    expect(evictions([page('a', 6), page('b', 4.9), page('c', 30, true)], now)).toEqual(['a'])
  })

  it('keeps at most four idle pages, unloading the least recently used', () => {
    const pages = [page('a', 1), page('b', 2), page('c', 3), page('d', 4), page('e', 0.5), page('f', 0.2), page('active', 9, true)]
    expect(evictions(pages, now)).toEqual(['d', 'c'])
  })

  it('makes room for a ninth page from the oldest idle one, or reports that every page is pinned', () => {
    const full = Array.from({ length: RESIDENCY.maxTotal }, (_, i) => page(`p${i}`, i, i !== 3 && i !== 5))
    expect(roomForPage(full)).toEqual({ evict: 'p5' })
    expect(roomForPage(full.map((p) => ({ ...p, pinned: true })))).toEqual({ full: true })
    expect(roomForPage(full.slice(1))).toEqual({})
  })
})
