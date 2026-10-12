import type { AgentId } from '../agents/types.ts'
import { isRefusal } from './refusals.ts'
import { parseConclusion } from './turns.ts'
import type { StoredEvent } from './types.ts'

// How each turn of a conversation ended, for the turn report (scripts/report-turns.ts). Pure.
// A turn runs from a message of yours to the next result, exit, error, agent switch or new agent
// process. A message sent while it runs (queued, or steering Codex's running turn) joins it: the
// agent answers both with one ending.

export type TurnOutcome =
  /** You stopped it. */
  | 'stopped'
  /** The agent or its process failed. */
  | 'failed'
  /** It ended with a "Question:" message. */
  | 'question'
  /** It ended with a "Blocked:" message. */
  | 'blocked'
  /** It ended with a message. */
  | 'concluded'
  /** It ended silently, and Cockpit's follow-up after a blocked step got a reply. */
  | 'recovered'
  /** It ended silently after a step was refused. */
  | 'silent_after_refusal'
  /** It ended silently. */
  | 'silent'

export interface TurnRow {
  readonly agent: AgentId
  readonly startedAt: string
  readonly outcome: TurnOutcome
  /** Tool calls in the turn. */
  readonly tools: number
  /** Input tokens, where the agent reports them per turn (Antigravity). */
  readonly tokensIn?: number
  readonly durationMs?: number
  /** Imported from the agent's own history, where turn ends are guessed; the report leaves these out. */
  readonly imported: boolean
}

const ENDS_TURN = new Set(['result', 'exit', 'error', 'session_boundary', 'agent_switch'])
const ANSWERED = new Set<TurnOutcome>(['concluded', 'question', 'blocked'])

interface OpenTurn {
  readonly index: number
  readonly agent: AgentId
  readonly startedAt: string
  readonly fromCockpit: boolean
}

/** "116,201 tokens (109,031 in, …)" → 109031 (Antigravity's per-turn usage line). */
export function tokensInOf(status: string): number | undefined {
  const match = /\(([\d,]+) in\b/.exec(status)
  return match ? Number(match[1]!.replace(/,/g, '')) : undefined
}

/** The agent of the first turn: the side the first switch left, else the conversation's agent now. */
function firstAgent(events: readonly StoredEvent[], current: AgentId): AgentId {
  const first = events.find((e) => e.event.kind === 'agent_switch')?.event
  return first?.kind === 'agent_switch' ? first.from : current
}

/** One row per finished turn, in order. `agent` is the conversation's agent now (meta.json). */
export function turnOutcomes(events: readonly StoredEvent[], agent: AgentId): TurnRow[] {
  const rows: (TurnRow & { readonly fromCockpit: boolean })[] = []
  const firstBoundary = events.findIndex((e) => e.event.kind === 'session_boundary')
  let current = firstAgent(events, agent)
  let open: OpenTurn | undefined

  /** `end`: the event that ended the turn. */
  const close = (end: number): void => {
    if (!open) return
    const turn = open
    open = undefined
    const last = events[end]!
    const closing = last.event
    const body = events.slice(turn.index + 1, end)
    let tools = 0
    let tokensIn: number | undefined
    let deniedCards = 0
    let refused = false
    let lastWork: { kind: 'tool' } | { kind: 'text'; text: string } | undefined
    for (const { event } of body) {
      if (event.kind === 'tool_use') { tools += 1; lastWork = { kind: 'tool' } }
      else if (event.kind === 'assistant_text') lastWork = { kind: 'text', text: event.text }
      else if (event.kind === 'usage' && event.limitType === 'last_turn') tokensIn = tokensInOf(event.status) ?? tokensIn
      else if (event.kind === 'approval_resolved' && (event.outcome ?? event.behavior) === 'deny') deniedCards += 1
      else if (event.kind === 'tool_result' && event.isError) {
        if (deniedCards > 0) { deniedCards -= 1; refused = true }
        else if (isRefusal(event.content)) refused = true
      }
    }
    const result = closing?.kind === 'result' ? closing : undefined
    // Cockpit imports only into a new conversation, so everything before its first agent process
    // was imported. Without one, older imports carry no marker: a bare success that shares its time
    // with your next message was added by the importer.
    const next = events[end + 1]
    const imported = turn.index < firstBoundary || Boolean(result && (result.synthetic || (firstBoundary < 0 && result.ok
      && result.durationMs === undefined && result.runId === undefined && next?.event.kind === 'user_text' && next.ts === last.ts)))
    const reply = lastWork?.kind === 'text' && lastWork.text.trim() !== '' ? lastWork.text : undefined
    const outcome: TurnOutcome =
      result?.stopped ? 'stopped'
      : closing?.kind === 'error' || closing?.kind === 'exit' || (result && (!result.ok || result.interrupted)) ? 'failed'
      : reply !== undefined ? (({ question: 'question', blocker: 'blocked', answer: 'concluded' } as const)[parseConclusion(reply).kind])
      : refused ? 'silent_after_refusal'
      : 'silent'
    rows.push({
      agent: turn.agent, startedAt: turn.startedAt, outcome, tools, imported, fromCockpit: turn.fromCockpit,
      ...(tokensIn !== undefined ? { tokensIn } : {}),
      ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    })
  }

  events.forEach(({ ts, event }, index) => {
    if (event.kind === 'user_text' && !open) open = { index, agent: current, startedAt: ts, fromCockpit: event.fromCockpit !== undefined }
    else if (ENDS_TURN.has(event.kind)) close(index)
    if (event.kind === 'agent_switch') current = event.to
  })

  // A silent turn whose Cockpit follow-up got a reply counts once, as recovered; the follow-up is not a turn of yours.
  return rows.flatMap(({ fromCockpit, ...row }, n) => {
    if (fromCockpit) return []
    const followUp = rows[n + 1]
    const silent = row.outcome === 'silent' || row.outcome === 'silent_after_refusal'
    return [silent && followUp?.fromCockpit && ANSWERED.has(followUp.outcome) ? { ...row, outcome: 'recovered' as const } : row]
  })
}
