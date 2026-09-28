import type { StoredEvent } from './types.ts'

const MAX_HANDOFF_CHARS = 24_000

/**
 * Builds the context a newly switched-in agent receives: the conversation so
 * far, newest material kept when it has to be trimmed. Provider-side history
 * can't be transferred, so this transcript is the handoff.
 */
export function buildHandoff(events: readonly StoredEvent[], projectPath: string): string {
  const lines = events.flatMap(({ event }): string[] => {
    switch (event.kind) {
      case 'user_text':
        return [`USER: ${event.text}`]
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
  let transcript = lines.join('\n')
  if (transcript.length > MAX_HANDOFF_CHARS) transcript = `[earlier conversation trimmed]\n${transcript.slice(-MAX_HANDOFF_CHARS)}`
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
