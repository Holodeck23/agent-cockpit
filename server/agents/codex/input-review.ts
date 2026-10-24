import type { OutgoingImage } from '../types.ts'

export interface CodexWaitingInput {
  readonly text: string
  readonly queuedId?: string
  readonly images?: readonly OutgoingImage[]
  readonly startupInput?: boolean
}

/** A source check never consumes input. Withdrawal/Stop fence its late result. */
export function createCodexInputReview(deps: {
  readonly check: (input: CodexWaitingInput) => Promise<void>
  readonly dispatch: (input: CodexWaitingInput) => void
  readonly failed: (error: unknown) => void
  readonly live: () => boolean
}) {
  type Job = { input: CodexWaitingInput; cancelled: boolean; dispatched: boolean }
  const waiting: Job[] = []
  let active: Job | undefined
  const pump = async (): Promise<void> => {
    if (active) return
    while (waiting.length && deps.live()) {
      const job = waiting.shift()!; active = job
      try {
        await deps.check(job.input)
        if (!job.cancelled && deps.live()) { job.dispatched = true; deps.dispatch(job.input) }
      } catch (error) {
        if (!job.cancelled && deps.live()) deps.failed(error)
      } finally { active = undefined }
    }
  }
  return {
    enqueue(input: CodexWaitingInput) {
      waiting.push({ input: { ...input, ...(input.images ? { images: input.images.map(image => ({ ...image })) } : {}) }, cancelled: false, dispatched: false })
      void pump()
    },
    has: () => Boolean(active && !active.cancelled && !active.dispatched) || waiting.length > 0,
    cancel(id: string): boolean {
      if (active?.input.queuedId === id && !active.cancelled && !active.dispatched) { active.cancelled = true; return true }
      const index = waiting.findIndex(job => job.input.queuedId === id)
      if (index < 0) return false
      waiting.splice(index, 1); return true
    },
    clear(): string[] {
      const ids: string[] = []
      if (active && !active.cancelled && !active.dispatched) {
        active.cancelled = true
        if (active.input.queuedId) ids.push(active.input.queuedId)
      }
      for (const job of waiting.splice(0)) if (job.input.queuedId) ids.push(job.input.queuedId)
      return ids
    },
  }
}
