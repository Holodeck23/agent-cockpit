import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../../server/threads/types.ts'
import type { ThreadUpdate } from '../../web/src/api.ts'
import { applyToSummaries } from '../../web/src/useCockpit.ts'

// u19-5: applyToSummaries mirrors server/threads/manager.ts QUIET (events that inform without being
// activity) but only kept three of its six kinds, so an account switch, a settings change, a
// suggestion or a workspace change re-dated every affected background conversation to "now" and lit
// its unread dot, although the server never counts them (lastActivityAt there skips QUIET kinds).

const row: ThreadSummary = {
  meta: { id: 't', title: 'Deploy', projectPath: '/p', settings: { agent: 'claude', permissionMode: 'manual', useHooks: false }, sessionId: 's', sessionStarted: true, completed: false, createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z' },
  status: 'done', preview: 'Staging is up', messageCount: 2, lastActivityAt: '2026-10-03T10:00:00Z',
} as unknown as ThreadSummary

const quiet: ThreadUpdate['event'][] = [
  { kind: 'awaiting_dismissed' },
  { kind: 'branch_changed', from: 'main', to: 'feature' },
  { kind: 'settings_changed', permissionMode: 'manual' },
  { kind: 'suggestion', text: 'Try the staging deploy' },
  { kind: 'account_changed', agent: 'claude', to: { id: 'acct-2' }, reason: 'selected', handoff: false } as ThreadUpdate['event'],
  { kind: 'workspace_changed', from: 'a', to: 'b', toLabel: 'feature', context: 'none' },
]

describe('live summary updates keep the server QUIET set out of activity', () => {
  for (const event of quiet) {
    it(`${event.kind} does not re-date the conversation`, () => {
      const [next] = applyToSummaries([row], { threadId: 't', status: 'done', event })
      expect(next?.lastActivityAt).toBe(row.lastActivityAt)
    })
  }

  it('a real message still counts as activity', () => {
    const [next] = applyToSummaries([row], { threadId: 't', status: 'working', event: { kind: 'assistant_text', messageId: 'm', text: 'Done' } })
    expect(next!.lastActivityAt! > row.lastActivityAt!).toBe(true)
  })
})
