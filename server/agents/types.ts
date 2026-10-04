// Agent-neutral event model. Every adapter translates its CLI's wire protocol
// into these events; threads, storage and the UI only ever see this union.

export type AgentId = 'claude' | 'codex' | 'antigravity' | 'opencode'

/** allow_session also applies the agent's own suggested rule for the rest of the session. */
export type ApprovalBehavior = 'allow' | 'allow_session' | 'deny'

export interface PendingApproval {
  readonly requestId: string
  readonly input: unknown
  readonly suggestions: readonly unknown[]
}

/** A workflow's instructions as they were when a message used it, so history never changes under edits. */
export interface WorkflowSnapshot {
  readonly name: string
  readonly prompt: string
}

/** One question an agent asks with fixed choices (Claude AskUserQuestion, Codex request_user_input). */
export interface AgentQuestion {
  /** The answer key: Claude keys answers by the question text, Codex by an id. */
  readonly id: string
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect: boolean
}

export type NormalizedEvent =
  | { kind: 'session_boundary' }
  | { kind: 'delegation_started'; requestKey: string }
  | { kind: 'completion_changed'; completed: boolean }
  /** You dismissed the question or blocker the last turn ended with. */
  | { kind: 'awaiting_dismissed' }
  /** Another conversation (or Cockpit) switched the project's branch; `byTitle` names that conversation. */
  | { kind: 'branch_changed'; from: string; to: string; byTitle?: string }
  /** Same agent, new model/effort/permissions; the native session continues from the next message. */
  | { kind: 'settings_changed'; model?: string; effort?: string; permissionMode: string }
  /** Cockpit-internal and never stored: the conversation was deleted. */
  | { kind: 'thread_deleted' }
  | { kind: 'session'; sessionId: string; model?: string; cwd?: string }
  /** `queuedId` is set when you sent it while the agent was working and the agent queues it (J1). */
  | { kind: 'user_text'; text: string; fromConversation?: { id: string; title: string }; workflows?: readonly WorkflowSnapshot[]; queuedId?: string }
  /** The agent took a message you sent; `id` names a queued one (J1). */
  | { kind: 'user_taken'; text: string; id?: string }
  /** You took a queued message back before the agent took it (J1); it went back to your draft. */
  | { kind: 'user_unqueued'; id: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; messageId: string; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /** The agent is summarising earlier context to make room (started), or has finished doing so. */
  | { kind: 'compaction'; phase: 'started' | 'finished'; ok?: boolean; trigger?: string; preTokens?: number; postTokens?: number }
  /**
   * A helper agent, keyed by the tool call that started it. Its own words and tool calls arrive as
   * progress (`text`, `tool`), never as the main agent's messages, so nothing reads them as the reply.
   */
  | {
      kind: 'subagent'; id: string; phase: 'started' | 'progress' | 'finished'
      description?: string; status?: string; lastTool?: string; text?: string; tool?: { name: string; input: unknown }
    }
  | { kind: 'question'; requestId: string; questions: readonly AgentQuestion[] }
  /** Answers keyed by question id; `dismissed` when you closed the questions without answering. */
  | { kind: 'question_answered'; requestId: string; answers: Readonly<Record<string, string>>; dismissed?: boolean }
  /** A predicted next message the agent offers as a one-click follow-up. */
  | { kind: 'suggestion'; text: string }
  | {
      kind: 'approval_request'
      requestId: string
      toolName: string
      input: unknown
      description?: string
      suggestions: unknown[]
    }
  | { kind: 'approval_resolved'; requestId: string; behavior: ApprovalBehavior }
  /** usedPercent only when the provider reports one; status stays the provider's own word. */
  | { kind: 'usage'; limitType: string; status: string; resetsAt?: number; usedPercent?: number }
  | { kind: 'result'; ok: boolean; stopped?: boolean; text?: string; costUsd?: number; durationMs?: number }
  | { kind: 'agent_switch'; from: AgentId; to: AgentId }
  | { kind: 'exit'; code: number | null }
  | { kind: 'error'; message: string }

export interface AgentSession {
  readonly agent: AgentId
  /** Send a user message. Resolves once written to the agent's stdin. */
  /** Delivers a turn to the agent. The thread manager records the user's own message. */
  send(text: string, queuedId?: string): void
  /** True when a message sent mid-turn waits in the agent's own queue and can be taken back (J1). */
  queues?(): boolean
  /** Takes back a queued message; false once the agent has taken it. */
  cancelQueued?(queuedId: string): Promise<boolean>
  respondApproval(approval: PendingApproval, behavior: ApprovalBehavior): void
  /** Answers (or, with undefined, dismisses) a `question` event; absent where the agent cannot ask. */
  respondQuestion?(question: PendingApproval, answers: Readonly<Record<string, string>> | undefined): void
  interrupt(): void
  /** Stdin EOF, escalating to SIGTERM/SIGKILL if the agent hangs on; resolves once it has exited. */
  close(): Promise<void>
  readonly alive: () => boolean
}

export type EventSink = (event: NormalizedEvent) => void
