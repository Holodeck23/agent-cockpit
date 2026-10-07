import { describe, expect, it } from 'vitest'
import { deriveStatus, openApprovals, runningHelpers, waitingMessages } from '../server/threads/status.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'
import type { StoredEvent } from '../server/threads/types.ts'
import { attribute, eventsIn, partition } from '../server/threads/workspace-events.ts'

// Order 18b (W12-15): two agents at once in one conversation, each in its own workspace. Each
// event belongs to one workspace, so one run's result or new session never closes the other's
// approvals, queue or helpers; older untagged events follow the conversation's own markers.

let tick = 0
const at = (event: NormalizedEvent, workspaceId?: string): StoredEvent => ({ ts: new Date(Date.UTC(2026, 9, 7, 20, 0, tick++)).toISOString(), event, ...(workspaceId ? { workspaceId } : {}) })

describe('which workspace an event belongs to', () => {
  it('uses the tag, and follows session boundaries and workspace changes for older events', () => {
    const events = [
      at({ kind: 'session_boundary', generation: 1, bindingId: 'b1', workspaceId: 'P' }),
      at({ kind: 'user_text', text: 'one' }),
      at({ kind: 'workspace_changed', from: 'P', to: 'W', toLabel: 'Rose bed', context: 'handoff' }),
      at({ kind: 'user_text', text: 'two' }),
      at({ kind: 'assistant_text', text: 'from P, tagged' } as NormalizedEvent, 'P'),
    ]
    expect(attribute(events)).toEqual(['P', 'P', 'W', 'W', 'P'])
    expect(partition(events).get('P')?.length).toBe(3)
    expect(eventsIn(events, 'W').map((e) => e.event.kind)).toEqual(['workspace_changed', 'user_text'])
  })

  it('keeps a conversation that never named a workspace as one part', () => {
    const events = [at({ kind: 'user_text', text: 'hi' }), at({ kind: 'result', ok: true })]
    expect(partition(events).size).toBe(1)
    expect(eventsIn(events, 'anything')).toHaveLength(2)
  })
})

describe('status across two workspaces at once', () => {
  const concurrent = () => [
    at({ kind: 'session_boundary', generation: 1, bindingId: 'p', workspaceId: 'P' }, 'P'),
    at({ kind: 'user_text', text: 'in P', runId: 'r1' }, 'P'),
    at({ kind: 'approval_request', requestId: 'ask-P', toolName: 'Bash', input: {}, suggestions: [] }, 'P'),
    at({ kind: 'session_boundary', generation: 2, bindingId: 'w', workspaceId: 'W' }, 'W'),
    at({ kind: 'user_text', text: 'in W', runId: 'r2', queuedId: 'q-W' }, 'W'),
    at({ kind: 'subagent', id: 'helper-W', phase: 'started', description: 'look' } as NormalizedEvent, 'W'),
    at({ kind: 'result', ok: true, runId: 'r0' }, 'W'),
  ]

  it('one workspace\'s new session and result leave the other\'s approval open', () => {
    expect(openApprovals(concurrent())).toEqual(['ask-P'])
  })

  it('keeps each workspace\'s queue and helpers', () => {
    expect(waitingMessages(concurrent())).toEqual(['q-W'])
    expect(runningHelpers(concurrent())).toEqual(['helper-W'])
  })

  it('reads as the most urgent workspace: an approval waiting in P while W works', () => {
    const events = concurrent()
    expect(deriveStatus(events, (w) => w === 'P' || w === 'W')).toBe('needs_input')
    expect(deriveStatus(events, (w) => w === 'W')).toBe('working')
    expect(deriveStatus(events, () => false)).toBe('done')
  })

  it('a single-workspace conversation reads exactly as before', () => {
    const events = [at({ kind: 'user_text', text: 'hi' }), at({ kind: 'approval_request', requestId: 'a', toolName: 'Bash', input: {}, suggestions: [] })]
    expect(deriveStatus(events, () => true)).toBe(deriveStatus(events, true))
    expect(deriveStatus(events, () => true)).toBe('needs_input')
  })
})
