// Agent-neutral event model. Every adapter translates its CLI's wire protocol
// into these events; threads, storage and the UI only ever see this union.

export type AgentId = 'claude' | 'codex'

export type ApprovalBehavior = 'allow' | 'deny'

export type NormalizedEvent =
  | { kind: 'session'; sessionId: string; model?: string; cwd?: string }
  | { kind: 'user_text'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; messageId: string; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
      kind: 'approval_request'
      requestId: string
      toolName: string
      input: unknown
      description?: string
      suggestions: unknown[]
    }
  | { kind: 'approval_resolved'; requestId: string; behavior: ApprovalBehavior }
  | { kind: 'usage'; limitType: string; status: string; resetsAt?: number }
  | { kind: 'result'; ok: boolean; text?: string; costUsd?: number; durationMs?: number }
  | { kind: 'exit'; code: number | null }
  | { kind: 'error'; message: string }

export interface AgentSession {
  readonly agent: AgentId
  /** Send a user message. Resolves once written to the agent's stdin. */
  send(text: string): void
  respondApproval(requestId: string, behavior: ApprovalBehavior, input?: unknown): void
  interrupt(): void
  /** Graceful shutdown (stdin EOF). */
  close(): void
  readonly alive: () => boolean
}

export type EventSink = (event: NormalizedEvent) => void
