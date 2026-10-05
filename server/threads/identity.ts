import { createHash } from 'node:crypto'
import type { StoredEvent, ThreadMeta } from './types.ts'

// Run and binding identity (G-IDENTITY). New events carry their IDs; conversations from before them
// derive the same IDs on every read, so nothing is rewritten and re-reading never changes an answer.

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)

/** The binding of a conversation saved before bindings existed: one per thread and native session. */
export function legacyBindingId(meta: Pick<ThreadMeta, 'id' | 'sessionId'>): string {
  return `legacy-${digest(`${meta.id}:${meta.sessionId}`)}`
}

export const bindingIdOf = (meta: ThreadMeta): string => meta.bindingId ?? legacyBindingId(meta)

/** A request's identity for idempotence: the exact text and image bytes, nothing else. */
export function inputHash(text: string, images: ReadonlyArray<{ bytes: Buffer }>): string {
  const hash = createHash('sha256').update(text)
  for (const image of images) hash.update('\0image\0').update(image.bytes)
  return hash.digest('hex')
}

export type RunOutcome = 'ok' | 'error' | 'stopped' | 'interrupted'

export interface RunSummary {
  readonly runId: string
  /** Index of the request that opened it. */
  readonly index: number
  readonly queued: boolean
  readonly ended: boolean
  readonly outcome?: RunOutcome
}

const runIdAt = (threadId: string, events: readonly StoredEvent[], index: number): string => {
  const event = events[index]!.event
  return (event.kind === 'user_text' && event.runId) || `legacy-${digest(`${threadId}:${index}`)}`
}

/**
 * Every request as a run, oldest first. A result names its run when it was recorded with one;
 * an older result ends the latest open run. A session ending without a result ends nothing here:
 * recovery decides what an unfinished run means.
 */
export function runsOf(threadId: string, events: readonly StoredEvent[]): RunSummary[] {
  const runs: Array<{ runId: string; index: number; queued: boolean; ended: boolean; outcome?: RunOutcome }> = []
  events.forEach(({ event }, index) => {
    if (event.kind === 'user_text') runs.push({ runId: runIdAt(threadId, events, index), index, queued: Boolean(event.queuedId), ended: false })
    else if (event.kind === 'user_unqueued') {
      const run = runs.find((r) => r.queued && events[r.index]!.event.kind === 'user_text' && (events[r.index]!.event as { queuedId?: string }).queuedId === event.id)
      if (run) { run.ended = true; run.outcome = 'stopped' }
    } else if (event.kind === 'result') {
      const run = event.runId ? runs.find((r) => r.runId === event.runId) : runs.findLast((r) => !r.ended)
      if (!run) return
      run.ended = true
      run.outcome = event.interrupted ? 'interrupted' : event.ok ? 'ok' : event.stopped ? 'stopped' : 'error'
      // Earlier requests still open were folded into this turn (or taken mid-turn): they finish with it.
      for (const r of runs) if (!r.ended && r.index < run.index) { r.ended = true; r.outcome = run.outcome }
    }
  })
  return runs
}

/** The run a crash left open, if the conversation's last request never finished. */
export function unfinishedRun(threadId: string, events: readonly StoredEvent[]): RunSummary | undefined {
  const last = runsOf(threadId, events).findLast((r) => !r.ended)
  if (!last) return undefined
  // A later result, exit or error means the turn did end; it just was not attributed.
  const after = events.slice(last.index + 1)
  return after.some(({ event }) => event.kind === 'result' || event.kind === 'exit' || event.kind === 'error') ? undefined : last
}
