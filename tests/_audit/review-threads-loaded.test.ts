// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCockpit, type Cockpit } from '../../web/src/useCockpit.ts'

// review of u01-1: App holds a notification click until the thread list has been read, and tells "not read
// yet" from "read, and empty" by useCockpit's threadsLoaded. It must stay false until the first list lands
// and become true then, whether or not the list has any conversations.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ rows: [] as unknown[], release: undefined as undefined | (() => void) }))

vi.mock('../../web/src/api.ts', () => ({
  api: {
    listThreads: () => new Promise((resolve) => { h.release = () => resolve(h.rows) }),
    thread: () => Promise.resolve(undefined),
    listProcesses: () => Promise.resolve([]),
    remoteStatus: () => Promise.resolve(undefined),
  },
  subscribe: () => () => undefined,
}))

let root: Root | undefined
let host: HTMLElement | undefined

async function mount(): Promise<() => Cockpit> {
  let latest: Cockpit | undefined
  const Probe = (): null => { latest = useCockpit(true); return null }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Probe)) })
  return () => latest!
}

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('threadsLoaded', () => {
  it('is false until the first thread list arrives, then true with that list', async () => {
    h.rows = [{ meta: { id: 't', title: 'Deploy' }, status: 'done', preview: '', messageCount: 1, lastActivityAt: '2026-10-10T10:00:00.000Z' }]
    const cockpit = await mount()
    expect(cockpit().threadsLoaded).toBe(false)
    expect(cockpit().threads).toHaveLength(0)
    await act(async () => { h.release!() })
    expect(cockpit().threadsLoaded).toBe(true)
    expect(cockpit().threads).toHaveLength(1)
  })

  it('is true for a list with no conversations in it', async () => {
    h.rows = []
    const cockpit = await mount()
    expect(cockpit().threadsLoaded).toBe(false)
    await act(async () => { h.release!() })
    expect(cockpit().threadsLoaded).toBe(true)
    expect(cockpit().threads).toHaveLength(0)
  })
})
