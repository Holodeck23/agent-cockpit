import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withAttachmentNote } from '../files/references.ts'
import type { StoredEvent } from './types.ts'
import type { AgentQuestion } from '../agents/types.ts'
import { takenBackPositions } from './taken-back.ts'

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
 * transferred, so this transcript is the handoff. Images are named by their stored file
 * (in `imagesDir`), so the new agent can open them.
 */
export function buildHandoff(events: readonly StoredEvent[], projectPath: string, imagesDir?: string): string {
  return composeHandoff(events, projectPath, imagesDir).text
}

/** What the picker shows before a switch (D13): the exact text, and how many messages were left out to fit. */
export interface HandoffPreview {
  readonly text: string
  /** sha256 of `text`; the switch carries it back so the agent receives only what was shown. */
  readonly digest: string
  readonly leftOut: number
  readonly budget: number
}

export const handoffDigest = (text: string): string => createHash('sha256').update(text).digest('hex')

export function previewHandoff(events: readonly StoredEvent[], projectPath: string, imagesDir?: string): HandoffPreview {
  const { text, leftOut } = composeHandoff(events, projectPath, imagesDir)
  return { text, digest: handoffDigest(text), leftOut, budget: HANDOFF_BUDGET }
}

/**
 * What a workspace's agent is told when the conversation moves to it (M1, W12.2): where it works
 * now, and either the conversation so far (a new native session) or only what happened elsewhere
 * since it last ran (its own session, resumed). Files in one workspace never contain another's work.
 */
export function workspaceContext(events: readonly StoredEvent[], where: string, mode: 'handoff' | 'catch-up', imagesDir?: string): string {
  const { transcript } = transcriptOf(events, imagesDir)
  return [
    mode === 'handoff'
      ? 'You are continuing a conversation that started in another workspace of this project.'
      : 'While you were idle, this conversation continued in another workspace of this project.',
    `You work in ${where}. Its files hold only what was done in this workspace: changes made in other workspaces are not here unless they were merged.`,
    mode === 'handoff' ? 'Conversation so far:' : 'What happened since you last ran:',
    '---',
    transcript,
    '---',
    mode === 'handoff' ? "Continue from here, in this workspace." : "The user's new message follows.",
  ].join('\n')
}

function composeHandoff(events: readonly StoredEvent[], projectPath: string, imagesDir?: string): { text: string; leftOut: number } {
  const { transcript, leftOut } = transcriptOf(events, imagesDir)
  const text = [
    'You are taking over a task another coding agent was working on in this project.',
    `Project folder: ${projectPath}. The files on disk reflect everything done so far.`,
    'Conversation so far:',
    '---',
    transcript,
    '---',
    "Continue from here. If the user's next message asks what has been done, answer from this transcript and the files.",
  ].join('\n')
  return { text, leftOut }
}

function transcriptOf(events: readonly StoredEvent[], imagesDir?: string): { transcript: string; leftOut: number } {
  // The conversation as it stands: a message you took back (and its images) never reached anyone.
  const skip = takenBackPositions(events)
  const questions = new Map<string, readonly AgentQuestion[]>()
  const lines = events.flatMap(({ event }, index): string[] => {
    if (skip.has(index)) return []
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
      case 'question':
        questions.set(event.requestId, event.questions)
        return event.questions.map((q) => `PREVIOUS AGENT ASKED: ${q.question} (options: ${q.options.map((o) => o.label).join(' / ')})`)
      case 'question_answered': {
        if (event.dismissed) return ['USER DISMISSED the question without answering']
        const asked = questions.get(event.requestId) ?? []
        return Object.entries(event.answers).map(([key, answer]) => {
          const question = asked.find((q) => q.id === key)?.question
          return `USER ANSWERED: ${answer}${question && asked.length > 1 ? ` (to: ${question})` : ''}`
        })
      }
      case 'agent_switch':
        return [`(switched from ${event.from} to ${event.to})`]
      case 'image':
        return imagesDir ? [`(${event.from === 'you' ? 'user attached' : 'previous agent showed'} an image: ${join(imagesDir, event.file)})`] : []
      default:
        return []
    }
  })
  // A conversation with nothing in it yet still hands over something the new agent can read (D14).
  return lines.length ? fitToBudget(lines) : { transcript: '(Nothing has been said in this conversation yet.)', leftOut: 0 }
}

function fitToBudget(lines: readonly string[]): { transcript: string; leftOut: number } {
  const whole = lines.join('\n')
  if (whole.length <= HANDOFF_BUDGET) return { transcript: whole, leftOut: 0 }
  const opening = lines.findIndex((line) => line.startsWith('USER: '))
  const head = opening >= 0 ? lines.slice(0, opening + 1) : []
  let used = head.reduce((sum, line) => sum + line.length + 1, 0)
  let start = lines.length
  while (start > head.length && used + lines[start - 1]!.length + 1 <= HANDOFF_BUDGET) used += lines[--start]!.length + 1
  const leftOut = start - head.length
  return { transcript: [...head, `[${leftOut} earlier messages left out to fit]`, ...lines.slice(start)].join('\n'), leftOut }
}
