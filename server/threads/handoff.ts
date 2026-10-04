import { withAttachmentNote } from '../files/references.ts'
import type { StoredEvent } from './types.ts'

/**
 * How much conversation a switched-in agent receives (J5): about 100k tokens, half of a
 * 200k context window, so a long conversation arrives whole and the agent still has room
 * to work. It was 24k characters until wave 5, which cut most real conversations.
 */
export const HANDOFF_BUDGET = 400_000

/**
 * Builds the context a newly switched-in agent receives: the conversation so
 * far, whole when it fits. Past the budget it keeps the opening request and the
 * newest messages, never half a message. Provider-side history can't be
 * transferred, so this transcript is the handoff.
 */
export function buildHandoff(events: readonly StoredEvent[], projectPath: string): string {
  const lines = events.flatMap(({ event }): string[] => {
    switch (event.kind) {
      case 'user_text':
        // References, not contents: the files on disk are current, a copy from then is not.
        return [`${event.fromConversation ? `FROM CONVERSATION ${event.fromConversation.title.replace(/[\r\n]/g, ' ')} (${event.fromConversation.id})` : 'USER'}: ${withAttachmentNote(event.text)}`]
      case 'assistant_text':
        return [`PREVIOUS AGENT: ${event.text}`]
      case 'tool_use': {
        const input = event.input as Record<string, unknown> | null
        const target = input?.command ?? input?.file_path ?? input?.path ?? ''
        return [`(previous agent used ${event.name}${target ? `: ${String(target).slice(0, 200)}` : ''})`]
      }
      case 'agent_switch':
        return [`(switched from ${event.from} to ${event.to})`]
      default:
        return []
    }
  })
  const transcript = fitToBudget(lines)
  return [
    'You are taking over a task another coding agent was working on in this project.',
    `Project folder: ${projectPath}. The files on disk reflect everything done so far.`,
    'Conversation so far:',
    '---',
    transcript,
    '---',
    "Continue from here. If the user's next message asks what has been done, answer from this transcript and the files.",
  ].join('\n')
}

function fitToBudget(lines: readonly string[]): string {
  const whole = lines.join('\n')
  if (whole.length <= HANDOFF_BUDGET) return whole
  const opening = lines.findIndex((line) => line.startsWith('USER: '))
  const head = opening >= 0 ? lines.slice(0, opening + 1) : []
  let used = head.reduce((sum, line) => sum + line.length + 1, 0)
  let start = lines.length
  while (start > head.length && used + lines[start - 1]!.length + 1 <= HANDOFF_BUDGET) used += lines[--start]!.length + 1
  return [...head, `[${start - head.length} earlier messages left out to fit]`, ...lines.slice(start)].join('\n')
}
