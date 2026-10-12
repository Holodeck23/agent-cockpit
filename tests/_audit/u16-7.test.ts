import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink } from '../../server/agents/types.ts'
import type { Observation } from '../../server/git/observe.ts'
import { createRunObservationStore, observeRuns } from '../../server/runs/observations.ts'
import { createThreadManager, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u16-7: deleting a conversation removed its threads/<id> files but left every runs/<runId>.json
// it produced (changed paths and content fingerprints) on disk forever.
// CORRECT behaviour: the run observer deletes a conversation's run records when it is deleted,
// and a run that was still being observed does not write one afterwards.

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-u16-7-'))
  const store = createThreadStore(join(root, 'threads'))
  const emits: EventSink[] = []
  const launcher: Launcher = (_request, onEvent) => {
    emits.push(onEvent)
    let alive = true
    const session: AgentSession = {
      agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
      close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => alive,
    }
    return session
  }
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
  const runs = createRunObservationStore(root)
  let release: () => void = () => undefined
  let gate: Promise<void> = Promise.resolve()
  const look = async (): Promise<Observation> => { await gate; return { repo: true, observedAt: 'now', head: null, branch: null, files: [], truncated: false, stable: true } }
  const observer = observeRuns(manager, runs, look)
  return { root, manager, runs, observer, emits, hold: () => { gate = new Promise<void>((r) => { release = r }) }, release: () => release() }
}
const settings = threadSettingsSchema.parse({})

describe('u16-7 a deleted conversation’s run records', () => {
  it('are deleted with it; other conversations’ records stay', async () => {
    const { root, manager, runs, observer, emits } = setup()
    const gone = manager.create({ projectPath: '/tmp', settings, text: 'one' })
    const kept = manager.create({ projectPath: '/tmp', settings, text: 'two' })
    const goneRun = manager.currentRunId(gone.id)!
    const keptRun = manager.currentRunId(kept.id)!
    emits[0]!({ kind: 'result', ok: true })
    emits[1]!({ kind: 'result', ok: true })
    await observer.settle()
    expect(runs.get(goneRun)?.threadId).toBe(gone.id)
    expect(existsSync(join(root, 'runs', `${goneRun}.json`))).toBe(true)

    await manager.remove(gone.id)
    await observer.settle()
    expect(existsSync(join(root, 'runs', `${goneRun}.json`))).toBe(false)
    expect(runs.get(goneRun)).toBeUndefined()
    expect(runs.get(keptRun)?.threadId).toBe(kept.id)
  })

  it('a run still being observed when its conversation is deleted writes nothing afterwards', async () => {
    const { root, manager, runs, observer, hold, release } = setup()
    hold()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'one' })
    const runId = manager.currentRunId(meta.id)!
    await manager.remove(meta.id)
    release()
    await observer.settle()
    expect(existsSync(join(root, 'runs', `${runId}.json`))).toBe(false)
    expect(runs.get(runId)).toBeUndefined()
    expect(observer.observing(runId)).toBe(false)
  })
})
