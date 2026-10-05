import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { observe, type Observation } from '../git/observe.ts'
import { StoreReadError } from '../state/read-error.ts'
import type { ThreadManager } from '../threads/manager.ts'
import { isBusy } from '../threads/status.ts'

// Before/after workspace observations of each run (W7-05), one file per run under runs/. The
// "before" is taken when the run starts (a queued message: when the agent takes it), the "after"
// when its result arrives. Nothing here claims a change was made by the run's agent: other
// conversations working in the same folder at the time are recorded alongside.

export const RUN_OBSERVATION_VERSION = 1
const RUN_ID = /^[A-Za-z0-9-]{1,80}$/

export interface RunObservation {
  readonly version: number
  readonly runId: string
  readonly threadId: string
  readonly projectPath: string
  readonly before?: Observation
  readonly after?: Observation
  /** The agent was already acting before the "before" observation finished. */
  readonly lateBefore?: boolean
  /** Other conversations in the same folder that were working during the run. */
  readonly concurrent?: readonly string[]
}

const observationSchema = z.object({
  repo: z.boolean(), observedAt: z.string(), head: z.string().nullable(), branch: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), oldPath: z.string().optional(), status: z.string(), fingerprint: z.string() })),
  truncated: z.boolean(), stable: z.boolean(),
})
const recordSchema = z.object({
  version: z.number(), runId: z.string(), threadId: z.string(), projectPath: z.string(),
  before: observationSchema.optional(), after: observationSchema.optional(),
  lateBefore: z.boolean().optional(), concurrent: z.array(z.string()).optional(),
})

export interface RunObservationStore {
  get(runId: string): RunObservation | undefined
  put(record: RunObservation): void
}

export function createRunObservationStore(root: string): RunObservationStore {
  const dir = join(root, 'runs')
  const fileOf = (runId: string): string => {
    if (!RUN_ID.test(runId)) throw new Error('Not a run ID')
    return join(dir, `${runId}.json`)
  }
  return {
    get(runId) {
      const file = fileOf(runId)
      if (!existsSync(file)) return undefined
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        throw new StoreReadError('UNREADABLE', file, error instanceof Error ? error.message : undefined)
      }
      const version = (parsed as { version?: unknown })?.version
      if (typeof version === 'number' && version > RUN_OBSERVATION_VERSION) throw new StoreReadError('FUTURE_VERSION', file)
      const result = recordSchema.safeParse(parsed)
      if (!result.success) throw new StoreReadError('UNREADABLE', file, 'unexpected contents')
      return result.data as RunObservation
    },
    put(record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = fileOf(record.runId)
      writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    },
  }
}

export interface RunObserver {
  /** Resolves once every observation started so far is stored (tests, shutdown). */
  settle(): Promise<void>
  stop(): void
}

/** Watches the manager's events and records each run's before/after observations. */
export function observeRuns(manager: ThreadManager, store: RunObservationStore, look: (path: string) => Promise<Observation> = observe): RunObserver {
  const queued = new Map<string, string>() // queued id -> run id
  interface Pending { threadId: string; projectPath: string; before: Promise<Observation | undefined>; read: { done: boolean }; late: boolean; concurrent: Set<string> }
  const pending = new Map<string, Pending>()
  const current = new Map<string, string>() // thread id -> run id in progress
  const work = new Set<Promise<void>>()
  const track = (promise: Promise<void>): void => { work.add(promise); void promise.finally(() => work.delete(promise)) }
  const metaOf = (threadId: string) => manager.summaries().find((s) => s.meta.id === threadId)?.meta
  const othersWorking = (threadId: string, projectPath: string): string[] =>
    manager.summaries().filter((s) => s.meta.id !== threadId && s.meta.projectPath === projectPath && isBusy(s.status)).map((s) => s.meta.title)

  const begin = (threadId: string, runId: string): void => {
    const meta = metaOf(threadId)
    if (!meta) return
    const read = { done: false }
    const before = look(meta.projectPath).then((o) => o, (error: unknown) => {
      console.warn('[cockpit] a run’s before-observation failed:', error instanceof Error ? error.message : error)
      return undefined
    }).finally(() => { read.done = true })
    const entry: Pending = { threadId, projectPath: meta.projectPath, before, read, late: false, concurrent: new Set(othersWorking(threadId, meta.projectPath)) }
    pending.set(runId, entry)
    current.set(threadId, runId)
    track(before.then((observation) => {
      if (observation && pending.get(runId) === entry) store.put({ version: RUN_OBSERVATION_VERSION, runId, threadId, projectPath: meta.projectPath, before: observation, ...(entry.late ? { lateBefore: true } : {}) })
    }))
  }

  const end = (threadId: string, runId: string): void => {
    const entry = pending.get(runId)
    pending.delete(runId)
    if (current.get(threadId) === runId) current.delete(threadId)
    if (!entry) return
    for (const title of othersWorking(threadId, entry.projectPath)) entry.concurrent.add(title)
    track((async () => {
      const before = await entry.before
      let after: Observation | undefined
      try { after = await look(entry.projectPath) } catch (error) {
        console.warn('[cockpit] a run’s after-observation failed:', error instanceof Error ? error.message : error)
      }
      store.put({
        version: RUN_OBSERVATION_VERSION, runId, threadId, projectPath: entry.projectPath,
        ...(before ? { before } : {}), ...(after ? { after } : {}),
        ...(entry.late ? { lateBefore: true } : {}), concurrent: [...entry.concurrent],
      })
    })())
  }

  const unsubscribe = manager.subscribe(({ threadId, event }) => {
    if (event.kind === 'tool_use' || event.kind === 'assistant_text' || event.kind === 'text_delta' || event.kind === 'user_text') {
      // Another conversation acting in the same folder during a run.
      const meta = metaOf(threadId)
      for (const entry of pending.values()) if (meta && entry.threadId !== threadId && entry.projectPath === meta.projectPath) entry.concurrent.add(meta.title)
    }
    switch (event.kind) {
      case 'user_text':
        if (!event.runId) return
        if (event.queuedId) queued.set(event.queuedId, event.runId)
        else begin(threadId, event.runId)
        return
      case 'user_taken': {
        const runId = event.id ? queued.get(event.id) : undefined
        if (!runId) return
        queued.delete(event.id!)
        // The run it joins ends here; the taken message's run starts.
        const previous = current.get(threadId)
        if (previous && previous !== runId) end(threadId, previous)
        begin(threadId, runId)
        return
      }
      case 'tool_use':
      case 'assistant_text':
      case 'text_delta': {
        // The agent acting while its run's "before" is still being read makes that read late.
        const runId = current.get(threadId)
        const own = runId ? pending.get(runId) : undefined
        if (own && !own.read.done) own.late = true
        return
      }
      case 'result': {
        const runId = event.runId ?? current.get(threadId)
        if (runId) end(threadId, runId)
        // Other runs in this conversation still open were folded into this turn.
        for (const [id, entry] of pending) if (entry.threadId === threadId) end(threadId, id)
        return
      }
      default:
    }
  })

  return {
    async settle() { while (work.size) await Promise.all([...work]) },
    stop: unsubscribe,
  }
}
