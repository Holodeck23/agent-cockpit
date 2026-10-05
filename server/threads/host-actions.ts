import { randomUUID } from 'node:crypto'
import type { ApprovalBehavior, NormalizedEvent } from '../agents/types.ts'

export interface HostActionOptions {
  readonly timeoutMs?: number
  /** Shown on the card. */
  readonly description?: string
  /** How errors name the action, e.g. "Conversation action". */
  readonly label?: string
  /**
   * Offers Allow for this session: an action with the same key in the same agent session then
   * runs without asking again. Forgotten when the session ends (`forget`).
   */
  readonly sessionKey?: string
}

/**
 * Approvals owned by Cockpit, never forwarded to the provider's protocol. The agent's own CLI
 * gate is bypassable (its session token is in its environment, so its shell can call the route
 * directly), so every Cockpit-side mutation an agent asks for is approved here, on the server.
 */
export function createHostActions(record: (threadId: string, event: NormalizedEvent) => void) {
  const pending = new Map<string, { threadId: string; sessionKey?: string; finish: (behavior: ApprovalBehavior, error?: string) => void }>()
  const allowedForSession = new Set<string>()
  return {
    request(threadId: string, toolName: string, input: unknown, signal?: AbortSignal, options: HostActionOptions = {}): Promise<void> {
      const { timeoutMs = 45_000, label = 'Conversation action', sessionKey } = options
      const description = options.description ?? 'Cockpit conversation control; one action only. Expires after 45 seconds.'
      if (sessionKey && allowedForSession.has(`${threadId}\n${sessionKey}`)) return Promise.resolve()
      if ([...pending.values()].some((p) => p.threadId === threadId)) return Promise.reject(new Error('Answer the pending Cockpit action first'))
      if (signal?.aborted) return Promise.reject(new Error(`${label} disconnected`))
      return new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const abort = () => finish('deny', `${label} disconnected`)
        const timer = setTimeout(() => finish('deny', `${label} approval expired; request it again${label === 'Conversation action' ? ' with a new request_key' : ''}`), timeoutMs)
        const finish = (behavior: ApprovalBehavior, error?: string) => {
          if (!pending.delete(requestId)) return
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          if (behavior === 'allow_session' && sessionKey) allowedForSession.add(`${threadId}\n${sessionKey}`)
          record(threadId, { kind: 'approval_resolved', requestId, behavior: behavior === 'deny' ? 'deny' : behavior === 'allow_session' && sessionKey ? 'allow_session' : 'allow' })
          if (behavior === 'deny') reject(new Error(error ?? `${label} denied by the user`))
          else resolve()
        }
        pending.set(requestId, { threadId, ...(sessionKey ? { sessionKey } : {}), finish })
        signal?.addEventListener('abort', abort, { once: true })
        // A non-empty suggestion list is what makes the card offer Allow for this session.
        const suggestions = sessionKey ? [{ type: 'cockpitSession', key: sessionKey }] : []
        record(threadId, { kind: 'approval_request', requestId, toolName, input, suggestions, description })
      })
    },
    approve(threadId: string, requestId: string, behavior: ApprovalBehavior): boolean {
      const action = pending.get(requestId)
      if (!action || action.threadId !== threadId) return false
      action.finish(behavior)
      return true
    },
    cancel(threadId?: string) {
      for (const action of [...pending.values()]) if (!threadId || action.threadId === threadId) action.finish('deny', 'The calling turn ended; the Cockpit action was canceled')
    },
    /** The agent session ended: what it was allowed for the session no longer applies. */
    forget(threadId: string) {
      for (const key of [...allowedForSession]) if (key.startsWith(`${threadId}\n`)) allowedForSession.delete(key)
    },
  }
}
