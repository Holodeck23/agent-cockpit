import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { observe, type Observation } from '../git/observe.ts'
import { isRefusal, workspaceFolder, type WorkspaceLookup } from '../projects/resolve.ts'
import { StoreReadError } from '../state/read-error.ts'
import type { ThreadManager } from '../threads/manager.ts'
import { isBusy } from '../threads/status.ts'
import type { ThreadMeta } from '../threads/types.ts'

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
  files: z.array(z.object({ path: z.string(), oldPath: z.string().optional(), status: z.string(), fingerprint: z.string(), stat: z.string().optional() })),
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
  /** Deletes every record the conversation's runs left (it was deleted). Unreadable files are left as found. */
  removeThread(threadId: string): void
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
    removeThread(threadId) {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const file = join(dir, name)
        try {
          const text = readFileSync(file, 'utf8')
          if (text.includes(threadId) && (JSON.parse(text) as { threadId?: unknown }).threadId === threadId) rmSync(file)
        } catch { /* a file that cannot be read is not known to be this conversation's: it stays as found */ }
      }
    },
  }
}

export interface RunObserver {
  /** The run started or ended and its observation is not stored yet. */
  observing(runId: string): boolean
  /** Resolves once every observation started so far is stored (tests, shutdown). */
  settle(): Promise<void>
  stop(): void
}

/** Watches the manager's events and records each run's before/after observations. */
export function observeRuns(manager: ThreadManager, store: RunObservationStore, look: (path: string) => Promise<Observation> = observe, workspace?: WorkspaceLookup): RunObserver {
  const queued = new Map<string, string>() // queued id -> run id
  interface Pending { threadId: string; workspaceId: string; projectPath: string; folder: string | undefined; before: Promise<Observation | undefined>; read: { done: boolean }; late: boolean; concurrent: Set<string> }
  const pending = new Map<string, Pending>()
  // One conversation can run in two workspaces at once (W12-15): a run belongs to its thread AND workspace.
  const current = new Map<string, string>() // thread id + workspace id -> run id in progress
  const keyOf = (threadId: string, workspaceId: string): string => `${threadId}\u0000${workspaceId}`
  const work = new Set<Promise<void>>()
  const finishing = new Set<string>()
  const gone = new Set<string>() // deleted conversations: nothing more is recorded for them
  // A write that fails (a full disk) is logged, never left as a rejection nobody handles or one settle() would rethrow.
  const track = (promise: Promise<void>): void => {
    const tracked = promise.catch((error: unknown) => {
      console.warn('[cockpit] a run’s observation could not be saved:', error instanceof Error ? error.message : error)
    }).finally(() => work.delete(tracked))
    work.add(tracked)
  }
  // Reading a conversation's meta derives every conversation's summary: done when it sends a message, not per streamed token.
  const metas = new Map<string, ThreadMeta>()
  const metaOf = (threadId: string): ThreadMeta | undefined => {
    const meta = manager.summaries().find((s) => s.meta.id === threadId)?.meta
    if (meta) metas.set(threadId, meta)
    return meta
  }
  const knownMeta = (threadId: string): ThreadMeta | undefined => metas.get(threadId) ?? metaOf(threadId)
  /** The folder the conversation works in (in `workspaceId`, the one a run belongs to, when given); undefined once its workspace is gone (never the primary in its place). */
  const folderOf = (meta: ThreadMeta, workspaceId?: string): string | undefined => {
    const folder = workspaceFolder(workspace, meta.projectPath, workspaceId || meta.workspaceId)
    return isRefusal(folder) ? undefined : folder.cwd
  }
  // The folders a conversation is working in: where its runs in progress are, else the workspace it is in now.
  const foldersWorking = (meta: ThreadMeta): Array<string | undefined> => {
    const open = [...pending.values()].filter((entry) => entry.threadId === meta.id).map((entry) => entry.folder)
    return open.length ? open : [folderOf(meta)]
  }
  // "Concurrent" means the same workspace: two conversations in different worktrees do not disturb each other.
  const othersWorking = (threadId: string, projectPath: string, folder: string | undefined): string[] =>
    manager.summaries().filter((s) => s.meta.id !== threadId && s.meta.projectPath === projectPath && isBusy(s.status) && foldersWorking(s.meta).includes(folder)).map((s) => s.meta.title)

  const begin = (threadId: string, runId: string, workspaceId: string): void => {
    const meta = knownMeta(threadId)
    if (!meta) return
    const read = { done: false }
    const folder = folderOf(meta, workspaceId)
    const before = (folder ? look(folder) : Promise.resolve(undefined)).then((o) => o, (error: unknown) => {
      console.warn('[cockpit] a run’s before-observation failed:', error instanceof Error ? error.message : error)
      return undefined
    }).finally(() => { read.done = true })
    const entry: Pending = { threadId, workspaceId, projectPath: meta.projectPath, folder, before, read, late: false, concurrent: new Set(othersWorking(threadId, meta.projectPath, folder)) }
    pending.set(runId, entry)
    current.set(keyOf(threadId, workspaceId), runId)
    track(before.then((observation) => {
      if (observation && pending.get(runId) === entry) store.put({ version: RUN_OBSERVATION_VERSION, runId, threadId, projectPath: meta.projectPath, before: observation, ...(entry.late ? { lateBefore: true } : {}) })
    }))
  }

  const end = (threadId: string, runId: string): void => {
    const entry = pending.get(runId)
    pending.delete(runId)
    if (!entry) return
    const key = keyOf(entry.threadId, entry.workspaceId)
    if (current.get(key) === runId) current.delete(key)
    for (const title of othersWorking(threadId, entry.projectPath, entry.folder)) entry.concurrent.add(title)
    finishing.add(runId)
    track((async () => {
      const before = await entry.before
      let after: Observation | undefined
      try { after = entry.folder ? await look(entry.folder) : undefined } catch (error) {
        console.warn('[cockpit] a run’s after-observation failed:', error instanceof Error ? error.message : error)
      }
      if (gone.has(threadId)) return
      store.put({
        version: RUN_OBSERVATION_VERSION, runId, threadId, projectPath: entry.projectPath,
        ...(before ? { before } : {}), ...(after ? { after } : {}),
        ...(entry.late ? { lateBefore: true } : {}), concurrent: [...entry.concurrent],
      })
    })().finally(() => finishing.delete(runId)))
  }

  const unsubscribe = manager.subscribe(({ threadId, event, workspaceId = '' }) => {
    if (event.kind === 'user_text') metaOf(threadId) // a message may have moved the conversation or renamed it
    if (event.kind === 'tool_use' || event.kind === 'assistant_text' || event.kind === 'text_delta' || event.kind === 'user_text') {
      // Another conversation acting in the same folder during a run.
      let meta: ThreadMeta | undefined
      for (const entry of pending.values()) {
        if (entry.threadId === threadId) continue
        meta ??= knownMeta(threadId)
        if (meta && entry.projectPath === meta.projectPath && entry.folder === folderOf(meta, workspaceId)) entry.concurrent.add(meta.title)
      }
    }
    switch (event.kind) {
      case 'user_text':
        if (!event.runId) return
        if (event.queuedId) queued.set(event.queuedId, event.runId)
        else begin(threadId, event.runId, workspaceId)
        return
      case 'user_taken': {
        const runId = event.id ? queued.get(event.id) : undefined
        if (!runId) return
        queued.delete(event.id!)
        // The run it joins (in the workspace that took it) ends here; the taken message's run starts.
        const previous = current.get(keyOf(threadId, workspaceId))
        if (previous && previous !== runId) end(threadId, previous)
        metaOf(threadId)
        begin(threadId, runId, workspaceId)
        return
      }
      case 'tool_use':
      case 'assistant_text':
      case 'text_delta': {
        // The agent acting while its run's "before" is still being read makes that read late.
        const runId = current.get(keyOf(threadId, workspaceId))
        const own = runId ? pending.get(runId) : undefined
        if (own && !own.read.done) own.late = true
        return
      }
      case 'result': {
        const runId = event.runId ?? current.get(keyOf(threadId, workspaceId))
        if (runId) end(threadId, runId)
        // Other runs of this session (this conversation in this workspace) still open were folded into this turn.
        for (const [id, entry] of pending) if (entry.threadId === threadId && entry.workspaceId === workspaceId) end(threadId, id)
        return
      }
      case 'thread_deleted': {
        // Nothing more is recorded for it, and what its runs recorded goes with it.
        gone.add(threadId)
        metas.delete(threadId)
        for (const [id, entry] of pending) if (entry.threadId === threadId) pending.delete(id)
        for (const key of current.keys()) if (key.startsWith(`${threadId}\u0000`)) current.delete(key)
        track(Promise.resolve().then(() => store.removeThread(threadId)))
        return
      }
      default:
    }
  })

  return {
    observing: (runId) => pending.has(runId) || finishing.has(runId),
    async settle() { while (work.size) await Promise.all([...work]) },
    stop: unsubscribe,
  }
}
