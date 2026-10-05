import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { previewOf } from '../server/threads/status.ts'
import { awaitingOf, latestConclusion, parseConclusion, turnRoles, TURN_GUIDANCE } from '../server/threads/turns.ts'
import { COCKPIT_GUIDANCE } from '../server/mcp/sessions.ts'
import type { StoredEvent } from '../server/threads/types.ts'

const log = (...events: NormalizedEvent[]): StoredEvent[] => events.map((event, i) => ({ ts: `2026-10-01T10:00:${String(i).padStart(2, '0')}Z`, event }))
const you = (text: string): NormalizedEvent => ({ kind: 'user_text', text })
const says = (text: string, id = text): NormalizedEvent => ({ kind: 'assistant_text', messageId: id, text })
const tool: NormalizedEvent = { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
const done: NormalizedEvent = { kind: 'result', ok: true }
const rolesOf = (events: StoredEvent[]) => [...turnRoles(events).entries()].map(([i, role]) => `${(events[i]!.event as { text: string }).text}=${role}`)

describe('turn shape', () => {
  it('reads acknowledgement, updates and conclusion in a finished turn', () => {
    expect(rolesOf(log(you('go'), says('On it.'), tool, says('Tests pass.'), says('Build is clean.'), says('Done: shipped.'), done)))
      .toEqual(['On it.=acknowledgement', 'Tests pass.=update', 'Build is clean.=update', 'Done: shipped.=conclusion'])
  })

  it('invents nothing: a lone message is the conclusion', () => {
    expect(rolesOf(log(you('hi'), says('Hello.'), done))).toEqual(['Hello.=conclusion'])
  })

  it('a first message after work has started is an update, not an acknowledgement', () => {
    expect(rolesOf(log(you('go'), tool, says('Found it.'), says('Fixed.'), done))).toEqual(['Found it.=update', 'Fixed.=conclusion'])
  })

  it('a running turn has no conclusion yet', () => {
    expect(rolesOf(log(you('go'), says('On it.'), tool, says('Halfway.')))).toEqual(['On it.=acknowledgement', 'Halfway.=update'])
  })

  it('a stop or crash still closes the turn', () => {
    expect(rolesOf(log(you('go'), says('On it.'), says('Partial.'), { kind: 'exit', code: 1 }))).toEqual(['On it.=acknowledgement', 'Partial.=conclusion'])
  })
})

describe('conclusions', () => {
  it('are typed by their opening marker, which is removed', () => {
    expect(parseConclusion('Question: Which port should it use?')).toEqual({ kind: 'question', text: 'Which port should it use?' })
    expect(parseConclusion('  blocked:  The API key is missing.')).toEqual({ kind: 'blocker', text: 'The API key is missing.' })
    expect(parseConclusion('Is this a question? Not by marker.')).toEqual({ kind: 'answer', text: 'Is this a question? Not by marker.' })
  })

  it('a question or blocker waits on you until you reply', () => {
    const asked = log(you('deploy'), says('Checking.'), says('Question: Production or staging?'), done)
    expect(awaitingOf(asked)).toBe('question')
    expect(awaitingOf([...asked, ...log(you('Staging'))])).toBeUndefined()
    expect(awaitingOf(log(you('go'), says('Blocked: No network.'), done))).toBe('blocker')
    expect(awaitingOf(log(you('go'), says('All good.'), done))).toBeUndefined()
  })

  it('Complete or Dismiss clears an open question, and reopening does not bring it back', () => {
    const asked = log(you('Deploy?'), says('Question: Staging or production?'), done)
    const completed = log(you('Deploy?'), says('Question: Staging or production?'), done, { kind: 'completion_changed', completed: true })
    expect(awaitingOf(completed)).toBeUndefined()
    expect(awaitingOf([...completed, ...log({ kind: 'completion_changed', completed: false })])).toBeUndefined()
    expect(awaitingOf([...asked, ...log({ kind: 'awaiting_dismissed' })])).toBeUndefined()
    // A new question after a dismissal waits again.
    expect(awaitingOf([...asked, ...log({ kind: 'awaiting_dismissed' }, you('ok'), says('Question: Which region?', 'q2'), done)])).toBe('question')
    expect(latestConclusion(log(you('go'), says('On it.')))).toBeUndefined()
  })

  it('the list preview shows the conclusion, never an update', () => {
    expect(previewOf(log(you('go'), says('On it.'), says('Halfway.'), says('Question: Keep the old logo?'), done))).toBe('Keep the old logo?')
    expect(previewOf(log(you('go'), says('On it.'), says('Halfway.')))).toBe('go')
    expect(previewOf(log(you('go'), says('Done.'), done, you('next'), says('Starting.')))).toBe('next')
  })
})

describe('guidance', () => {
  it('asks every Cockpit session for the turn shape and the two markers', () => {
    expect(COCKPIT_GUIDANCE).toContain(TURN_GUIDANCE)
    expect(TURN_GUIDANCE).toMatch(/"Question:"/)
    expect(TURN_GUIDANCE).toMatch(/"Blocked:"/)
  })
})

describe('compactingNow and runningHelpers', async () => {
  const { compactingNow, runningHelpers } = await import('../server/threads/status.ts')
  const e = (event: NormalizedEvent): StoredEvent => ({ ts: '2026-10-04T10:00:00.000Z', event })
  it('is compacting only between a start and its finish, within a turn', () => {
    expect(compactingNow([e({ kind: 'compaction', phase: 'started' })])).toBe(true)
    expect(compactingNow([e({ kind: 'compaction', phase: 'started' }), e({ kind: 'text_delta', text: 'x' })])).toBe(true)
    expect(compactingNow([e({ kind: 'compaction', phase: 'started' }), e({ kind: 'compaction', phase: 'finished', ok: true })])).toBe(false)
    expect(compactingNow([e({ kind: 'compaction', phase: 'started' }), e({ kind: 'result', ok: false })])).toBe(false)
  })
  it('counts helpers started and not finished in the current session', () => {
    expect(runningHelpers([e({ kind: 'subagent', id: 'a', phase: 'started' }), e({ kind: 'subagent', id: 'b', phase: 'started' }),
      e({ kind: 'subagent', id: 'a', phase: 'finished' })])).toEqual(['b'])
    expect(runningHelpers([e({ kind: 'subagent', id: 'a', phase: 'started' }), e({ kind: 'exit', code: 0 })])).toEqual([])
  })
})

describe('latestTurn and the status timer (A11)', async () => {
  const { latestTurn } = await import('../server/threads/status.ts')
  const { statusText } = await import('../web/src/components/StatusPill.tsx')
  const at = (second: number, event: NormalizedEvent): StoredEvent => ({ ts: new Date(Date.UTC(2026, 9, 4, 10, 0, second)).toISOString(), event })
  it('starts at your message and ends at the result', () => {
    const turn = latestTurn([at(0, { kind: 'user_text', text: 'a' }), at(3, { kind: 'assistant_text', messageId: 'm', text: 'x' }), at(12, { kind: 'result', ok: false })])
    expect(turn).toEqual({ startedAt: at(0, { kind: 'thread_deleted' }).ts, endedAt: at(12, { kind: 'thread_deleted' }).ts })
    expect(statusText('error', turn, Date.now())).toBe('Error · 0:12')
  })
  it('counts up while working, and starts again when the agent reports back unasked', () => {
    const turn = latestTurn([at(0, { kind: 'user_text', text: 'a' }), at(2, { kind: 'result', ok: true }),
      at(20, { kind: 'subagent', id: 'h', phase: 'finished' }), at(21, { kind: 'assistant_text', messageId: 'm', text: 'report' })])
    expect(turn).toEqual({ startedAt: at(21, { kind: 'thread_deleted' }).ts })
    expect(statusText('working', turn, Date.parse(at(28, { kind: 'thread_deleted' }).ts))).toBe('Working · 0:07')
    expect(statusText('done', turn, 0)).toBe('Ready')
  })
  it('Starting counts up from your message too, then hands over to Working (Day 10)', async () => {
    const { deriveStatus } = await import('../server/threads/status.ts')
    const launched = [at(0, { kind: 'session_boundary' }), at(0, { kind: 'user_text', text: 'a' })]
    expect(deriveStatus(launched, true)).toBe('starting')
    expect(statusText('starting', latestTurn(launched), Date.parse(at(3, { kind: 'thread_deleted' }).ts))).toBe('Starting · 0:03')
    expect(deriveStatus([...launched, at(4, { kind: 'session', sessionId: 's' })], true)).toBe('working')
    // Your own image is not the agent reporting in; the agent's is.
    expect(deriveStatus([...launched, at(1, { kind: 'image', file: 'a.png', mediaType: 'image/png', from: 'you' })], true)).toBe('starting')
    expect(deriveStatus([...launched, at(1, { kind: 'image', file: 'b.png', mediaType: 'image/png', from: 'agent' })], true)).toBe('working')
    // No turn in flight, no Starting: a launch that never reported back reads as Waiting after a restart.
    expect(deriveStatus(launched, false)).toBe('idle')
  })
})
