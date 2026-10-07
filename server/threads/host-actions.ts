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
  /**
   * Offers a second Allow whose scope the caller keeps itself (the browser's "for this run on
   * <site>" grant): the request resolves `allow_session` and nothing is remembered here.
   */
  readonly grant?: { readonly label: string }
  /** The workspace whose agent asked (W12-15): its card, its cancel and its session memory are its own. */
  readonly workspaceId?: string
}

/**
 * Approvals owned by Cockpit, never forwarded to the provider's protocol. The agent's own CLI
 * gate is bypassable (its session token is in its environment, so its shell can call the route
 * directly), so every Cockpit-side mutation an agent asks for is approved here, on the server.
 */
export function createHostActions(record: (threadId: string, event: NormalizedEvent, workspaceId?: string) => void) {
  const pending = new Map<string, { threadId: string; workspaceId: string; sessionKey?: string; finish: (behavior: ApprovalBehavior, error?: string) => void }>()
  const allowedForSession = new Set<string>()
  // One agent session per conversation and workspace: what it was allowed lives and ends with it.
  const sessionOf = (threadId: string, workspaceId = ''): string => `${threadId}\n${workspaceId}\n`
  return {
    /** Resolves `allow`, or `allow_session` when the person chose the session or grant option. */
    request(threadId: string, toolName: string, input: unknown, signal?: AbortSignal, options: HostActionOptions = {}): Promise<Exclude<ApprovalBehavior, 'deny'>> {
      const { timeoutMs = 45_000, label = 'Conversation action', sessionKey, grant, workspaceId = '' } = options
      const description = options.description ?? 'Cockpit conversation control; one action only. Expires after 45 seconds.'
      if (sessionKey && allowedForSession.has(`${sessionOf(threadId, workspaceId)}${sessionKey}`)) return Promise.resolve('allow_session')
      if ([...pending.values()].some((p) => p.threadId === threadId && p.workspaceId === workspaceId)) return Promise.reject(new Error('Answer the pending Cockpit action first'))
      if (signal?.aborted) return Promise.reject(new Error(`${label} disconnected`))
      return new Promise((resolve, reject) => {
        const requestId = randomUUID()
        const abort = () => finish('deny', `${label} disconnected`)
        const timer = setTimeout(() => finish('deny', `${label} approval expired; request it again${label === 'Conversation action' ? ' with a new request_key' : ''}`), timeoutMs)
        const finish = (behavior: ApprovalBehavior, error?: string) => {
          if (!pending.delete(requestId)) return
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          if (behavior === 'allow_session' && sessionKey) allowedForSession.add(`${sessionOf(threadId, workspaceId)}${sessionKey}`)
          const chosen = behavior === 'deny' ? 'deny' : behavior === 'allow_session' && (sessionKey || grant) ? 'allow_session' : 'allow'
          record(threadId, { kind: 'approval_resolved', requestId, behavior: chosen }, workspaceId || undefined)
          if (chosen === 'deny') reject(new Error(error ?? `${label} denied by the user`))
          else resolve(chosen)
        }
        pending.set(requestId, { threadId, workspaceId, ...(sessionKey ? { sessionKey } : {}), finish })
        signal?.addEventListener('abort', abort, { once: true })
        // A non-empty suggestion list is what makes the card offer Allow for this session.
        const suggestions = grant ? [{ type: 'cockpitGrant', label: grant.label }] : sessionKey ? [{ type: 'cockpitSession', key: sessionKey }] : []
        record(threadId, { kind: 'approval_request', requestId, toolName, input, suggestions, description }, workspaceId || undefined)
      })
    },
    approve(threadId: string, requestId: string, behavior: ApprovalBehavior): boolean {
      const action = pending.get(requestId)
      if (!action || action.threadId !== threadId) return false
      action.finish(behavior)
      return true
    },
    /** Everything pending; or one conversation's; or (with `workspaceId`) one of its workspaces'. */
    cancel(threadId?: string, workspaceId?: string) {
      for (const action of [...pending.values()]) {
        if (threadId && action.threadId !== threadId) continue
        if (workspaceId !== undefined && action.workspaceId !== workspaceId) continue
        action.finish('deny', 'The calling turn ended; the Cockpit action was canceled')
      }
    },
    /** An agent session ended: what it was allowed for the session no longer applies (every workspace's without `workspaceId`). */
    forget(threadId: string, workspaceId?: string) {
      const prefix = workspaceId === undefined ? `${threadId}\n` : sessionOf(threadId, workspaceId)
      for (const key of [...allowedForSession]) if (key.startsWith(prefix)) allowedForSession.delete(key)
    },
  }
}
