import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readClaudeSession } from '../../server/import/sessions.ts'

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary: ...'
const projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-audit-u10-1-')))
const row = (type: 'user' | 'assistant', content: unknown, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, cwd: projectPath, sessionId: 's', uuid: `${type}-${ts}`, timestamp: ts, message: { role: type, content }, ...extra })

describe('u10-1: Claude import must not turn CLI-generated rows into typed prompts', () => {
  it('skips the /compact summary row and "[Request interrupted by user]" markers', () => {
    const text = [
      row('user', [{ type: 'text', text: 'Fix the login bug' }], '2026-10-01T09:00:00.000Z'),
      row('assistant', [{ type: 'text', text: 'Looking at it.' }], '2026-10-01T09:00:01.000Z'),
      // Claude Code writes this as a user row when you press Esc mid-turn.
      row('user', [{ type: 'text', text: '[Request interrupted by user]' }], '2026-10-01T09:00:02.000Z'),
      row('user', [{ type: 'text', text: 'Actually, also fix logout' }], '2026-10-01T09:00:03.000Z'),
      row('assistant', [{ type: 'text', text: 'Done.' }], '2026-10-01T09:00:04.000Z'),
      // Written by /compact: a CLI-generated summary, flagged isCompactSummary.
      row('user', [{ type: 'text', text: SUMMARY }], '2026-10-01T09:00:05.000Z', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      row('user', [{ type: 'text', text: 'Now add tests' }], '2026-10-01T09:00:06.000Z'),
      row('assistant', [{ type: 'text', text: 'Adding.' }], '2026-10-01T09:00:07.000Z'),
    ].join('\n')

    const s = readClaudeSession(text, 's', projectPath, '2026-10-01T10:00:00.000Z')
    const typed = s.events.flatMap((e) => (e.event.kind === 'user_text' ? [e.event.text] : []))
    expect(typed).toEqual(['Fix the login bug', 'Actually, also fix logout', 'Now add tests'])
    // 3 typed prompts + 3 assistant replies (before the fix: 5 user rows + 3 = 8).
    expect(s.messages).toBe(6)
  })

  it('does not name a resumed-after-compaction session after the summary', () => {
    const text = [
      row('user', SUMMARY, '2026-10-01T09:00:00.000Z', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      row('user', [{ type: 'text', text: 'Continue with the migration' }], '2026-10-01T09:00:01.000Z'),
      row('assistant', [{ type: 'text', text: 'Continuing.' }], '2026-10-01T09:00:02.000Z'),
    ].join('\n')
    const s = readClaudeSession(text, 's', projectPath, '2026-10-01T10:00:00.000Z')
    expect(s.firstPrompt).toBe('Continue with the migration')
  })
})
