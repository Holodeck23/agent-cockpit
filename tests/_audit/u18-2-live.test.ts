// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamHandlers, ThreadDetail, ThreadUpdate } from '../../web/src/api.ts'
import { buildActivity } from '../../web/src/activity.ts'
import { useCockpit, type Cockpit } from '../../web/src/useCockpit.ts'

// u18-2 (live half): buildActivity keys open calls by workspace once a conversation has two, but a
// live-streamed event only carries its workspace if useCockpit stores the update's workspaceId.
// Streamed live, workspace B finishing a turn must leave workspace A's running tool running.

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

describe('u18-2: live events from two workspaces in Activity', () => {
  it('workspace B ending its turn does not interrupt workspace A\'s tool, and A\'s later result is recorded', async () => {
    // The conversation starts empty; both workspaces appear only through live updates.
    h.detail = { meta: { id: 't', title: 'Deploy' }, status: 'working', events: [], transcriptPath: '', streaming: '' } as unknown as ThreadDetail
    const cockpit = await mount()
    act(() => { cockpit().select('t') })
    await flush()

    const send = (workspaceId: string, event: ThreadUpdate['event']): void => { act(() => { h.handlers!.onUpdate(update({ workspaceId, event })) }) }
    send('ws-main', { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'npm run build' } })
    send('ws-worktree', { kind: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/p/b.ts' } })
    send('ws-worktree', { kind: 'tool_result', toolUseId: 'toolu_B', content: 'ok', isError: false })
    send('ws-worktree', { kind: 'result', ok: true })

    let rows = buildActivity(cockpit().detail!.events)
    expect(rows.map((r) => [r.id, r.state])).toEqual([['toolu_A', 'running'], ['toolu_B', 'done']])

    send('ws-main', { kind: 'tool_result', toolUseId: 'toolu_A', content: 'build succeeded', isError: false })
    rows = buildActivity(cockpit().detail!.events)
    expect(rows[0]).toMatchObject({ id: 'toolu_A', state: 'done', output: 'build succeeded' })
  })
})
