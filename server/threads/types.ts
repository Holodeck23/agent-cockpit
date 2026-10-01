import { z } from 'zod'
import { EFFORTS, PERMISSION_MODES } from '../agents/claude/flags.ts'
import type { NormalizedEvent } from '../agents/types.ts'

export const threadSettingsSchema = z.object({
  agent: z.enum(['claude', 'codex']).default('claude'),
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9._\-[\]]+$/)
    .optional(),
  effort: z.enum(EFFORTS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('manual'),
  useHooks: z.boolean().default(false),
})
export type ThreadSettings = z.output<typeof threadSettingsSchema>

export interface ThreadMeta {
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
  readonly createdAt: string
  readonly updatedAt: string
}

export type ThreadStatus = 'idle' | 'working' | 'needs_input' | 'done' | 'error'

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
}
