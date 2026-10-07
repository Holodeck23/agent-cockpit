import { describe, expect, it } from 'vitest'
import { accountName } from '../web/src/components/AccountChoice.tsx'
import { buildTranscript } from '../web/src/transcript.ts'
import type { StoredEvent } from '../server/threads/types.ts'

// W12-03/04 in the conversation: an account change is said where it is read, with both accounts
// and whether the conversation so far goes with the next message; an unknown identity is unknown.

const note = (event: StoredEvent['event']): string => {
  const item = buildTranscript([{ ts: '2026-10-07T12:00:00Z', event }], 'claude').find((i) => i.type === 'note')
  return item && 'text' in item ? String(item.text) : ''
}

describe('account changes in the transcript', () => {
  it('a chosen account names both and says the conversation goes with it', () => {
    expect(note({ kind: 'account_changed', agent: 'claude', reason: 'selected', handoff: true,
      from: { id: 'default-claude', label: 'CLI default', hint: 'a…@example.com · pro' }, to: { id: 'x', label: 'Work', hint: 'w…@example.com · pro' } }))
      .toBe('Account changed from CLI default (a…@example.com · pro) to Work (w…@example.com · pro). Your next message starts a new Claude Code session on it; the conversation so far goes with it.')
  })

  it('an outside change of the default sign-in says what it was and is now, or that it is unconfirmed', () => {
    expect(note({ kind: 'account_changed', agent: 'codex', reason: 'identity_changed', handoff: true,
      from: { id: 'default-codex', label: 'CLI default', hint: 'a…@example.com · plus' }, to: { id: 'default-codex', label: 'CLI default', hint: 'z…@example.com · plus' } }))
      .toMatch(/^Codex's default sign-in changed outside Cockpit \(was a…@example\.com · plus\); it is now z…@example\.com · plus\./)
    expect(note({ kind: 'account_changed', agent: 'claude', reason: 'identity_changed', handoff: false, to: { id: 'default-claude', label: 'CLI default' } }))
      .toBe("Claude Code's default sign-in changed outside Cockpit; it is now an account Cockpit could not confirm. Your next message starts on it.")
  })

  it('names an account by label and hint, and an unknown one as unknown', () => {
    const base = { id: 'x', agent: 'claude', label: 'Work', mode: 'managed', isolation: 'CLAUDE_CONFIG_DIR', generation: 1, usageKey: 'x#1' } as const
    expect(accountName({ ...base, identity: { state: 'known', hint: 'w…@example.com · pro', observedAt: '', source: 'claude auth status' } })).toBe('Work · w…@example.com · pro')
    expect(accountName({ ...base, identity: { state: 'unknown', observedAt: '', source: 'claude auth status' } })).toBe('Work · account unknown')
  })
})
