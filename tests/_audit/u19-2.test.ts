// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamHandlers, ThreadDetail, ThreadUpdate } from '../../web/src/api.ts'
import { useCockpit, type Cockpit } from '../../web/src/useCockpit.ts'

// u19-2: the server stores every session event with the workspaceId it came from and broadcasts the
// same workspaceId on the update. useCockpit's onUpdate builds the live StoredEvent as { ts, event }
// and drops it, so live events of a multi-workspace conversation are attributed by guesswork
// (workspace-events.ts attribute) until a reload, while the same events after a reload are tagged.
// CORRECT behaviour: the live StoredEvent carries the update's workspaceId.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ handlers: undefined as StreamHandlers | undefined, detail: undefined as unknown }))

vi.mock('../../web/src/api.ts', () => ({
  api: {
    listThreads: () => Promise.resolve([{ meta: { id: 't', title: 'Deploy' }, status: 'working', preview: '', messageCount: 1, lastActivityAt: '2026-10-10T10:00:00.000Z' }]),
    thread: () => Promise.resolve(h.detail),
    listProcesses: () => Promise.resolve([]),
    remoteStatus: () => Promise.resolve(undefined),
  },
  subscribe: (handlers: StreamHandlers) => { h.handlers = handlers; return () => { h.handlers = undefined } },
}))

let root: Root | undefined
let host: HTMLElement | undefined
const flush = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) }) }

async function mount(): Promise<() => Cockpit> {
  let latest: Cockpit | undefined
  const Probe = (): null => { latest = useCockpit(true); return null }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Probe)) })
  await flush()
  return () => latest!
}

const update = (u: Partial<ThreadUpdate> & Pick<ThreadUpdate, 'event'>): ThreadUpdate => ({ threadId: 't', status: 'working', ...u }) as ThreadUpdate

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('a live event keeps the workspace the server sent', () => {
  it('stores the update\'s workspaceId on the event, and none when the update had none', async () => {
    h.detail = { meta: { id: 't', title: 'Deploy' }, status: 'working', events: [], transcriptPath: '', streaming: '' } as unknown as ThreadDetail
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()
    expect(cockpit().detail).toBeDefined()

    act(() => { h.handlers!.onUpdate(update({ workspaceId: 'ws-worktree', event: { kind: 'assistant_text', messageId: 'm', text: 'from the worktree' } })) })
    act(() => { h.handlers!.onUpdate(update({ event: { kind: 'assistant_text', messageId: 'm', text: 'from the main checkout' } })) })

    const events = cockpit().detail!.events
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ workspaceId: 'ws-worktree', event: { kind: 'assistant_text', messageId: 'm', text: 'from the worktree' } })
    expect(events[1]).not.toHaveProperty('workspaceId')
  })
})
