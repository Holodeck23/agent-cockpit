import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { Observation } from '../../server/git/observe.ts'
import { createRunObservationStore, observeRuns, type RunObservationStore } from '../../server/runs/observations.ts'
import type { ThreadManager, ThreadUpdate } from '../../server/threads/manager.ts'

// u16-4: a failed write of a run's observation (a full disk) rejected the tracked promise: an
// unhandled rejection (fatal for a plain `npm start` server) and a settle() that rejects, which
// made the server's close() reject before it closed the server.
// CORRECT behaviour: the failure is logged; settle() resolves; nothing is left unhandled.

describe('u16-4 a run observation that cannot be saved', () => {
  let warned: ReturnType<typeof vi.spyOn>
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  beforeEach(() => { warned = vi.spyOn(console, 'warn').mockImplementation(() => {}); unhandled.length = 0; process.on('unhandledRejection', onUnhandled) })
  afterEach(() => { warned.mockRestore(); process.off('unhandledRejection', onUnhandled) })

  it('is logged, settle() still resolves and nothing is unhandled', async () => {
    const listeners = new Set<(u: ThreadUpdate) => void>()
    const manager = {
      subscribe: (l: (u: ThreadUpdate) => void) => { listeners.add(l); return () => listeners.delete(l) },
      summaries: () => [{ meta: { id: 't1', title: 'Mine', projectPath: '/proj' }, status: 'working' }],
    } as unknown as ThreadManager
    const emit = (event: NormalizedEvent): void => { for (const l of listeners) l({ threadId: 't1', event, status: 'working' } as ThreadUpdate) }
    const real = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-u16-4-')))
    const store: RunObservationStore = { ...real, put: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) } }
    const look = (): Promise<Observation> => Promise.resolve({ repo: true, observedAt: 'now', head: null, branch: null, files: [], truncated: false, stable: true })
    const observer = observeRuns(manager, store, look)

    emit({ kind: 'user_text', text: 'go', runId: 'run-1' })
    emit({ kind: 'result', ok: true, runId: 'run-1' })
    await expect(observer.settle()).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unhandled).toEqual([])
    expect(observer.observing('run-1')).toBe(false)
    expect(warned).toHaveBeenCalled()
  })
})
