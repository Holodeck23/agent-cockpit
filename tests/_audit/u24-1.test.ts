// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Processes } from '../../web/src/components/Processes.tsx'
import type { ProcessInfo, Project } from '../../web/src/api.ts'
import { createOutputBuffer, type OutputBuffer } from '../../server/processes/output.ts'
import { readCursor } from '../../server/http/process-routes.ts'

// u24-1: the process log polls with { since } and no tail. The server route answers a missing tail
// with 200 (`tail ?? 200`), keeps only the newest 200 lines of what is newer than `since`, and still
// reports next = the last line number, so every line before those 200 is skipped for good with no
// note. The poll is also not serialised: a slow answer lets the next tick ask with the same cursor,
// and both answers then append the same lines.
// CORRECT behaviour: the Output pane shows every line the process wrote (up to the pane's 2000-line
// window), once each, however many arrive between polls.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { name: 'demo', path: '/proj' } as unknown as Project
const info = {
  id: 'p1', name: 'dev', command: 'npm run dev', projectPath: '/proj', cwd: '/proj', status: 'running', startedAt: '2026-10-10T10:00:00Z',
  exitCode: null, signal: null, owner: { kind: 'project' },
} as unknown as ProcessInfo

let root: Root | undefined
let host: HTMLElement | undefined
let buffer: OutputBuffer
let delayMs = 0

/** The server's GET /api/processes/:id/output, over a real output buffer and the route's own cursor parsing. */
function serve(path: string): Promise<Response> {
  const url = new URL(path, 'http://localhost')
  const since = readCursor(url.searchParams.get('since'), Number.MAX_SAFE_INTEGER)
  const tail = readCursor(url.searchParams.get('tail'), 2000)
  const slice = buffer.read({ ...(since !== undefined ? { since } : {}), tail: tail ?? 200 })
  const response = new Response(JSON.stringify({ data: slice }), { status: 200 })
  const wait = since === undefined ? 0 : delayMs
  return wait ? new Promise((resolve) => setTimeout(() => resolve(response), wait)) : Promise.resolve(response)
}

const feed = (from: number, to: number): void => {
  let text = ''
  for (let n = from; n <= to; n++) text += `out ${n}\n`
  buffer.push('stdout', text)
}

beforeEach(() => {
  vi.useFakeTimers()
  delayMs = 0
  buffer = createOutputBuffer()
  feed(1, 1)
  vi.stubGlobal('fetch', vi.fn(async (path: string) => serve(String(path))))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement(Processes, { project, processes: [info], onError: () => undefined, onOpenSite: () => undefined }))
  })
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const advance = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const shownLines = (): string[] => (host!.querySelector('pre.process-log')?.textContent ?? '').split('\n').filter((t) => /^out \d+$/.test(t))

describe('u24-1: the process log keeps every line, once', () => {
  it('600 lines inside one poll interval all reach the pane', async () => {
    await advance(0)
    expect(shownLines()).toEqual(['out 1'])
    feed(2, 601)
    await advance(1000)
    const shown = shownLines()
    expect(shown).toHaveLength(601)
    expect(shown[0]).toBe('out 1')
    expect(shown[300]).toBe('out 301')
    expect(shown.at(-1)).toBe('out 601')
  })

  it('a slow answer does not make the next tick append the same lines twice', async () => {
    await advance(0)
    delayMs = 1500
    feed(2, 4)
    await advance(4500)
    expect(shownLines()).toEqual(['out 1', 'out 2', 'out 3', 'out 4'])
  })
})
