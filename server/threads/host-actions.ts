import { randomUUID } from 'node:crypto'
import type { ApprovalBehavior, NormalizedEvent } from '../agents/types.ts'

/** Approvals owned by Cockpit, never forwarded to the provider's protocol. */
export function createHostActions(record: (threadId: string, event: NormalizedEvent) => void) {
  const pending = new Map<string, { threadId: string; finish: (behavior: ApprovalBehavior, error?: string) => void }>()
  return {
    request(threadId: string, toolName: string, input: unknown, signal?: AbortSignal, timeoutMs = 45_000): Promise<void> {
      if ([...pending.values()].some((p) => p.threadId === threadId)) return Promise.reject(new Error('Answer the pending conversation action first'))
      if (signal?.aborted) return Promise.reject(new Error('Conversation action disconnected'))
      return new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const abort = () => finish('deny', 'Conversation action disconnected')
        const timer = setTimeout(() => finish('deny', 'Conversation action approval expired; request it again with a new request_key'), timeoutMs)
        const finish = (behavior: ApprovalBehavior, error?: string) => {
          if (!pending.delete(requestId)) return
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          record(threadId, { kind: 'approval_resolved', requestId, behavior: behavior === 'deny' ? 'deny' : 'allow' })
          if (behavior === 'deny') reject(new Error(error ?? 'Conversation action denied by the user'))
          else resolve()
        }
        pending.set(requestId, { threadId, finish })
        signal?.addEventListener('abort', abort, { once: true })
        record(threadId, { kind: 'approval_request', requestId, toolName, input, suggestions: [], description: 'Cockpit conversation control; one action only. Expires after 45 seconds.' })
      })
    },
    approve(threadId: string, requestId: string, behavior: ApprovalBehavior): boolean {
      const action = pending.get(requestId)
      if (!action || action.threadId !== threadId) return false
      action.finish(behavior)
      return true
    },
    cancel(threadId?: string) {
      for (const action of [...pending.values()]) if (!threadId || action.threadId === threadId) action.finish('deny', 'The calling turn ended; conversation action canceled')
    },
  }
}
