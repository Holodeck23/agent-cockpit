import type { StoredEvent } from './types.ts'

// The shape of a turn (U12): an acknowledgement, updates, a conclusion.
//  - acknowledgement: the agent's first message, when it comes before any tool use and is not the
//    turn's only message, so long work never looks stalled;
//  - updates: messages between the two;
//  - conclusion: the last message of a finished turn, typed by how it opens:
//    "Question:" (the agent needs something from you), "Blocked:" (it cannot go on), else an answer.
// Cockpit asks agents for this shape (TURN_GUIDANCE) but never relies on it: nothing is invented,
// a turn with one message has only a conclusion, and an untagged conclusion is an answer.

export type TurnRole = 'acknowledgement' | 'update' | 'conclusion'
export type ConclusionKind = 'answer' | 'question' | 'blocker'

export const TURN_GUIDANCE = [
  'Cockpit shows each turn as an acknowledgement, updates and a conclusion.',
  'Start with one short sentence saying what you are about to do, give brief updates only when a step matters,',
  'and end with a final message that holds the result.',
  'If you need an answer from the user before you can continue, start that final message with "Question:".',
  'If something outside your control stops you, start it with "Blocked:". Otherwise never start a message with those words.',
].join(' ')

const MARKER = /^\s*(question|blocked)\s*:\s*/i

/** The kind a conclusion's opening marks, and its text without the marker. */
export function parseConclusion(text: string): { kind: ConclusionKind; text: string } {
  const match = MARKER.exec(text)
  if (!match) return { kind: 'answer', text }
  return { kind: match[1]!.toLowerCase() === 'question' ? 'question' : 'blocker', text: text.slice(match[0].length) }
}

const ENDS_TURN = new Set(['result', 'exit', 'error', 'session_boundary', 'agent_switch'])

/** Role of every agent message, by its index in `events`. A turn still running has no conclusion yet. */
export function turnRoles(events: readonly StoredEvent[]): Map<number, TurnRole> {
  const roles = new Map<number, TurnRole>()
  let messages: number[] = []
  let workedBeforeFirst = false
  const close = (ended: boolean): void => {
    messages.forEach((index, n) => {
      const last = n === messages.length - 1
      if (ended && last) roles.set(index, 'conclusion')
      else if (n === 0 && !workedBeforeFirst && (messages.length > 1 || !ended)) roles.set(index, 'acknowledgement')
      else roles.set(index, 'update')
    })
    messages = []
    workedBeforeFirst = false
  }
  events.forEach(({ event }, index) => {
    if (event.kind === 'user_text') close(true)
    else if (event.kind === 'assistant_text') messages.push(index)
    else if ((event.kind === 'tool_use' || event.kind === 'approval_request') && messages.length === 0) workedBeforeFirst = true
    else if (ENDS_TURN.has(event.kind)) close(true)
  })
  close(false)
  return roles
}

/** The latest conclusion, as the list shows it (marker removed), with its kind; undefined before the first one. */
export function latestConclusion(events: readonly StoredEvent[]): { kind: ConclusionKind; text: string; index: number } | undefined {
  const roles = turnRoles(events)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!.event
    if (event.kind === 'assistant_text' && roles.get(i) === 'conclusion') return { ...parseConclusion(event.text), index: i }
  }
  return undefined
}

/**
 * A finished conversation waiting on you: its last turn ended with a question or a blocker, and
 * since then you haven't replied, marked the conversation complete, or dismissed it.
 */
export function awaitingOf(events: readonly StoredEvent[]): 'question' | 'blocker' | undefined {
  const conclusion = latestConclusion(events)
  if (!conclusion || conclusion.kind === 'answer') return undefined
  const settled = events.slice(conclusion.index + 1).some(({ event }) =>
    event.kind === 'user_text' || event.kind === 'awaiting_dismissed' || (event.kind === 'completion_changed' && event.completed))
  return settled ? undefined : conclusion.kind
}
