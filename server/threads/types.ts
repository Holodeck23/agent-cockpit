import { z } from 'zod'
import { ALL_EFFORTS, PERMISSION_MODES } from '../agents/claude/flags.ts'
import type { AgentId, NormalizedEvent } from '../agents/types.ts'

export const threadSettingsSchema = z.object({
  agent: z.enum(['claude', 'codex', 'antigravity', 'opencode']).default('claude'),
  /** "/" and ":" for OpenCode's provider/model names (openrouter/openai/gpt-4o:free); each agent's launcher checks its own. */
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9._\-[\]/:]+$/)
    .optional(),
  effort: z.enum(ALL_EFFORTS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('manual'),
  useHooks: z.boolean().default(false),
  /** Use my Chrome (H4, Claude only): applies at the next launch, so only while the conversation is idle. */
  useChrome: z.boolean().optional(),
})
export type ThreadSettings = z.output<typeof threadSettingsSchema>

/** A workspace's own native session within a conversation, kept while the conversation works elsewhere. */
export interface WorkspaceBinding {
  readonly agent: AgentId
  readonly bindingId: string
  readonly sessionId: string
  readonly sessionStarted: boolean
  readonly accountId?: string
  readonly accountGeneration?: number
  /** Stored events when this binding was last active: context after it is what it has not seen. */
  readonly cursor: number
}

export interface ThreadMeta {
  readonly createdByThreadId?: string
  readonly delegationDepth?: number
  readonly workflowId?: string
  readonly workflowTrigger?: 'manual' | 'scheduled'
  readonly id: string
  readonly title: string
  readonly projectPath: string
  readonly settings: ThreadSettings
  /** Agent-side session id; a new one is minted when the agent is switched. */
  readonly sessionId: string
  /** True once the agent has seen at least one message under sessionId. */
  readonly sessionStarted: boolean
  readonly completed: boolean
  /** Transcript handed to the next agent session after a switch; cleared once delivered. */
  readonly handoff?: string
  /** Project instructions revision the current agent session started with (absent: none). */
  readonly instructionsRevision?: number
  /** That revision's text, so the thread can show what its session received even after edits. */
  readonly instructionsText?: string
  /** Opaque primary workspace (G-IDENTITY); absent on conversations from before it, resolved by projectPath. */
  readonly workspaceId?: string
  /** This agent + session's binding; minted with sessionId. Legacy conversations derive one (identity.ts). */
  readonly bindingId?: string
  /** Agent processes launched for this conversation so far; stamped on each session_boundary. */
  readonly sessionGeneration?: number
  /**
   * Native-session bindings saved for the conversation's OTHER workspaces (M1, W12.2), keyed by
   * workspace ID. The top-level session/binding/account fields are always the binding of
   * `workspaceId`, the workspace the conversation works in now; switching swaps them.
   */
  readonly bindings?: Readonly<Record<string, WorkspaceBinding>>
  /** What happened in other workspaces since this binding last ran; prepended once to its next message. */
  readonly catchUp?: string
  /** The account the current native session runs under (W12.1); absent before accounts: the CLI default. */
  readonly accountId?: string
  /** That account's identity generation when the session started; a different one never resumes it. */
  readonly accountGeneration?: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type ThreadStatus = 'idle' | 'starting' | 'working' | 'needs_input' | 'done' | 'error'

export interface StoredEvent {
  readonly ts: string
  readonly event: NormalizedEvent
}

export interface ThreadSummary {
  readonly meta: ThreadMeta
  readonly status: ThreadStatus
  readonly preview: string
  /** Messages from you and the agent (not tool calls). */
  readonly messageCount: number
  /** Time of the latest event, or the metadata's updatedAt if there are none. */
  readonly lastActivityAt: string
  /** The last turn ended with a question or a blocker you haven't answered (U12). */
  readonly awaiting?: 'question' | 'blocker'
  /** The latest turn's span, for the status timer (A11). */
  readonly turn?: { readonly startedAt: string; readonly endedAt?: string }
  /** The first question the agent is asking right now with choices (J6), while it waits on you. */
  readonly asking?: string
}
