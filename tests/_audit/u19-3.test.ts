// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamHandlers, ThreadDetail, ThreadUpdate } from '../../web/src/api.ts'
import { useCockpit, type Cockpit } from '../../web/src/useCockpit.ts'

// u19-3: reloadDetail throws its answer away and asks again whenever an event arrived during the
// request, and onUpdate counted EVERY event of the selected thread, text_delta included. While a
// reply streams (many deltas a second) any thread read slower than the gap between two deltas is
// discarded and re-issued with no backoff: the conversation sits on "Loading conversation..." and
// the server serves back-to-back full-thread reads. After an SSE reconnect the transcript stays stale.
// CORRECT behaviour: a delta does not restart the read (a persisted event still does), and the
// streamed text still ends up complete: the snapshot's partial plus the deltas it did not include.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Request { resolve(detail: ThreadDetail): void }
const h = vi.hoisted(() => ({ handlers: undefined as StreamHandlers | undefined, requests: [] as Request[] }))

vi.mock('../../web/src/api.ts', () => ({
  api: {
    listThreads: () => Promise.resolve([{ meta: { id: 't', title: 'Deploy' }, status: 'working', preview: '', messageCount: 1, lastActivityAt: '2026-10-10T10:00:00.000Z' }]),
    thread: () => new Promise((resolve) => { h.requests.push({ resolve: resolve as Request['resolve'] }) }),
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

const detail = (extra: Partial<ThreadDetail> = {}): ThreadDetail =>
  ({ meta: { id: 't', title: 'Deploy' }, status: 'working', events: [], transcriptPath: '', streaming: '', ...extra }) as unknown as ThreadDetail
const delta = (text: string): ThreadUpdate => ({ threadId: 't', status: 'working', event: { kind: 'text_delta', text } })
const emit = (u: ThreadUpdate): void => { act(() => { h.handlers!.onUpdate(u) }) }
const answer = async (index: number, d: ThreadDetail): Promise<void> => { await act(async () => { h.requests[index]!.resolve(d); await Promise.resolve() }); await flush() }

beforeEach(() => { h.requests.length = 0 })

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('opening a conversation that is streaming', () => {
  it('a delta during the read does not throw the answer away', async () => {
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()
    expect(h.requests).toHaveLength(1)

    emit(delta(' wor'))
    await answer(0, detail({ streaming: 'Hello' }))

    expect(h.requests).toHaveLength(1)
    expect(cockpit().detail).toBeDefined()
    // The delta came after the snapshot was taken: nothing of the reply is lost.
    expect(cockpit().streaming).toBe('Hello wor')
  })

  it('does not repeat a delta the snapshot already holds', async () => {
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()

    emit(delta('Hel'))
    emit(delta('lo wor'))
    emit(delta('ld'))
    // The server answered after "lo wor" had been sent but before "ld".
    await answer(0, detail({ streaming: 'Hello wor' }))

    expect(h.requests).toHaveLength(1)
    expect(cockpit().streaming).toBe('Hello world')
  })

  it('keeps each workspace\'s stream apart', async () => {
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()

    emit({ ...delta('B2'), workspaceId: 'b' })
    await answer(0, detail({ runs: [{ workspaceId: 'a', working: true, partial: 'A1' }, { workspaceId: 'b', working: true, partial: 'B1' }] }))

    expect(cockpit().streams).toEqual({ a: 'A1', b: 'B1B2' })
  })

  it('a stored event during the read still makes it read again', async () => {
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()

    emit({ threadId: 't', status: 'working', event: { kind: 'assistant_text', messageId: 'm', text: 'First paragraph' } })
    await answer(0, detail())
    expect(h.requests).toHaveLength(2)
    expect(cockpit().detail).toBeUndefined()

    await answer(1, detail({ events: [{ ts: '2026-10-10T10:00:01.000Z', event: { kind: 'assistant_text', messageId: 'm', text: 'First paragraph' } }] }))
    expect(cockpit().detail?.events).toHaveLength(1)
  })
})

describe('reconnecting while a reply streams', () => {
  it('re-reads once; deltas do not keep it from landing', async () => {
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()
    await answer(0, detail())
    expect(cockpit().detail).toBeDefined()

    act(() => { h.handlers!.onOpen!() })
    await flush()
    expect(h.requests).toHaveLength(2)
    emit(delta('x'))
    emit(delta('y'))
    await answer(1, detail({ streaming: 'wxy', events: [{ ts: '2026-10-10T10:00:01.000Z', event: { kind: 'user_text', text: 'missed while offline' } }] }))

    expect(h.requests).toHaveLength(2)
    expect(cockpit().detail?.events).toHaveLength(1)
    expect(cockpit().streaming).toBe('wxy')
  })
})
