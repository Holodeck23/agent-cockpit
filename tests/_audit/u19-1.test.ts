// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOpenFiles } from '../../web/src/useOpenFiles.ts'

// u19-1: a draft is stored with the disk version it started from. Reopening it against a changed
// file marks it as a conflict, but only in memory; the persist effect then rewrote the stored
// version to the CURRENT disk version. On the next remount (leave Files and come back, or relaunch)
// the stored version matched the disk, the conflict was gone, Save was enabled and wrote the stale
// draft over the other edit.
// CORRECT behaviour: a draft keeps the version it started from until the person resolves the
// conflict, so it is still a conflict after any number of remounts.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  disk: { text: '', version: '' },
  writes: [] as Array<{ text: string; expected: string | null }>,
}))

vi.mock('../../web/src/api.ts', () => {
  class ApiError extends Error { constructor(message: string, readonly status: number) { super(message) } }
  return {
    ApiError,
    api: {
      readFile: async (_project: string, path: string) => ({ path, text: h.disk.text, version: h.disk.version }),
      writeFile: async (_project: string, path: string, text: string, expected: string | null) => {
        h.writes.push({ text, expected })
        if (expected !== h.disk.version) throw new ApiError('This file changed on disk since you opened it', 409)
        h.disk = { text, version: `${h.disk.version}+` }
        return { path, bytes: text.length, version: h.disk.version }
      },
    },
  }
})

const PROJECT = '/proj'
const DRAFT_KEY = `file-draft:${PROJECT}:notes.md`

let mounted: Array<{ root: Root; host: HTMLElement }> = []
const flush = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }

async function mount(): Promise<{ files: () => ReturnType<typeof useOpenFiles>; unmount: () => void }> {
  let latest: ReturnType<typeof useOpenFiles> | undefined
  const Probe = (): null => { latest = useOpenFiles(PROJECT); return null }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => { root.render(createElement(Probe)) })
  await flush()
  return { files: () => latest!, unmount: () => { act(() => { root.unmount() }); host.remove(); mounted = mounted.filter((m) => m.root !== root) } }
}

const stored = (): { draft: string; version: string } | undefined => {
  const raw = localStorage.getItem(DRAFT_KEY)
  return raw ? (JSON.parse(raw) as { draft: string; version: string }) : undefined
}

beforeEach(() => {
  localStorage.clear()
  h.disk = { text: 'original\n', version: 'v1' }
  h.writes.length = 0
})

afterEach(() => {
  for (const { root, host } of mounted) { act(() => { root.unmount() }); host.remove() }
  mounted = []
})

describe('a draft whose file changed on disk', () => {
  it('is still a conflict after a second remount, and its stored version stays the one it started from', async () => {
    // First visit: edit notes.md without saving.
    const first = await mount()
    await act(async () => { await first.files().open('notes.md') })
    act(() => { first.files().edit('notes.md', 'my edit\n') })
    await flush()
    expect(stored()).toEqual({ draft: 'my edit\n', version: 'v1' })
    first.unmount()

    // An agent changes the file meanwhile.
    h.disk = { text: 'agent edit\n', version: 'v2' }

    // Second visit: the conflict is shown...
    const second = await mount()
    expect(second.files().files).toHaveLength(1)
    expect(second.files().files[0]).toMatchObject({ path: 'notes.md', draft: 'my edit\n', conflict: true })
    // ...the person types a little more, which persists every draft again...
    act(() => { second.files().edit('notes.md', 'my edit, more\n') })
    await flush()
    expect(stored()?.version).toBe('v1')
    second.unmount()

    // Third visit: nothing was resolved, so it is still a conflict and Save must stay disabled.
    const third = await mount()
    expect(third.files().files[0]).toMatchObject({ draft: 'my edit, more\n', conflict: true })
  })

  it('the stale draft cannot be written with a plain save', async () => {
    localStorage.setItem(`cockpit:file-tabs:${PROJECT}`, JSON.stringify({ paths: ['notes.md'], active: 'notes.md' }))
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft: 'my edit\n', version: 'v1' }))
    h.disk = { text: 'agent edit\n', version: 'v2' }
    const visit = await mount()
    expect(visit.files().files[0]?.conflict).toBe(true)

    await act(async () => { await visit.files().save('notes.md') })
    // The disk still holds the agent's edit.
    expect(h.disk).toEqual({ text: 'agent edit\n', version: 'v2' })
    expect(visit.files().files[0]?.conflict).toBe(true)
  })

  it('"Overwrite with mine" still saves over the disk version it just read', async () => {
    localStorage.setItem(`cockpit:file-tabs:${PROJECT}`, JSON.stringify({ paths: ['notes.md'], active: 'notes.md' }))
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft: 'my edit\n', version: 'v1' }))
    h.disk = { text: 'agent edit\n', version: 'v2' }
    const visit = await mount()

    await act(async () => { await visit.files().overwrite('notes.md') })
    expect(h.disk.text).toBe('my edit\n')
    expect(visit.files().files[0]).toMatchObject({ conflict: false, text: 'my edit\n' })
    expect(stored()).toBeUndefined()
  })
})
