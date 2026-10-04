import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../server/threads/types.ts'
import { applyToSummaries } from '../web/src/useCockpit.ts'

const row: ThreadSummary = {
  meta: { id: 't', title: 'Deploy', projectPath: '/p', settings: { agent: 'claude', permissionMode: 'manual', useHooks: false }, sessionId: 's', sessionStarted: true, completed: false, createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z' },
  status: 'done', preview: 'Question: Staging?', messageCount: 2, lastActivityAt: '2026-10-03T10:00:00Z', awaiting: 'question',
}

describe('live summary updates', () => {
  it('a dismissal clears the question without counting as activity', () => {
    const [next] = applyToSummaries([row], { threadId: 't', status: 'done', event: { kind: 'awaiting_dismissed' } })
    expect(next?.awaiting).toBeUndefined()
    expect(next?.lastActivityAt).toBe(row.lastActivityAt)
  })

  it('Mark complete clears the question; Reopen does not bring it back', () => {
    const [completed] = applyToSummaries([row], { threadId: 't', status: 'done', event: { kind: 'completion_changed', completed: true } })
    expect(completed).toMatchObject({ awaiting: undefined, meta: { completed: true } })
    const [reopened] = applyToSummaries([completed!], { threadId: 't', status: 'done', event: { kind: 'completion_changed', completed: false } })
    expect(reopened?.awaiting).toBeUndefined()
  })
})

describe('the list pill timer stays live (A11)', () => {
  it('starts a turn at your message, ends it at the result, and keeps it through a queued message', () => {
    const ended = { ...row, turn: { startedAt: '2026-10-03T09:00:00Z', endedAt: '2026-10-03T09:00:05Z' } }
    const [started] = applyToSummaries([ended], { threadId: 't', status: 'working', event: { kind: 'user_text', text: 'go' } })
    expect(started!.turn).toEqual({ startedAt: expect.any(String) })
    expect(started!.turn!.startedAt > '2026-10-03T09:00:05Z').toBe(true)
    const [queued] = applyToSummaries([started!], { threadId: 't', status: 'working', event: { kind: 'user_text', text: 'more', queuedId: 'q' } })
    expect(queued!.turn).toEqual(started!.turn)
    const [done] = applyToSummaries([queued!], { threadId: 't', status: 'error', event: { kind: 'result', ok: false } })
    expect(done!.turn?.endedAt).toEqual(expect.any(String))
  })
})
