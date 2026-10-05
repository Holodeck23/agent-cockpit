import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectDir, listSessions, readClaudeSession, readCodexSession } from '../server/import/sessions.ts'
import { CLAUDE_SESSION, claudeSessionText, CODEX_SESSION, codexSessionText, writeImportHome } from '../scripts/lib/import-fixtures.ts'

const project = '/Users/someone/work/my_site.v2'
const kinds = (events: Array<{ event: { kind: string } }>) => events.map((e) => e.event.kind)

describe('importing Claude Code sessions', () => {
  it('finds the project folder the way Claude Code names it', () => {
    expect(claudeProjectDir('/home', project)).toBe('/home/.claude/projects/-Users-someone-work-my-site-v2')
  })

  it('keeps what you typed, the replies and tool steps, with their times; drops thinking, side chains and command echoes', () => {
    const s = readClaudeSession(claudeSessionText(project), CLAUDE_SESSION, project, '2026-09-30T10:00:00.000Z')
    expect(kinds(s.events)).toEqual(['user_text', 'assistant_text', 'tool_use', 'tool_result', 'assistant_text', 'result', 'user_text', 'assistant_text', 'result'])
    expect(s.events[0]).toEqual({ ts: '2026-09-30T09:00:01.000Z', event: { kind: 'user_text', text: 'Add a dark mode toggle to the header' } })
    expect(JSON.stringify(s.events)).not.toMatch(/secret reasoning|Side chain|command-name/)
    expect(s).toMatchObject({ agent: 'claude', sessionId: CLAUDE_SESSION, firstPrompt: 'Add a dark mode toggle to the header', messages: 5 })
  })

  it('ignores lines recorded in another folder', () => {
    expect(readClaudeSession(claudeSessionText('/elsewhere'), CLAUDE_SESSION, project, '2026-09-30T10:00:00.000Z').messages).toBe(0)
    // A message line without a folder is not this project's, whatever directory it sits in (L13).
    const planted = `${JSON.stringify({ type: 'user', sessionId: CLAUDE_SESSION, message: { role: 'user', content: 'Planted instruction' } })}\n`
    expect(readClaudeSession(planted, CLAUDE_SESSION, project, '2026-09-30T10:00:00.000Z').messages).toBe(0)
  })
})

describe('importing Codex sessions', () => {
  it('keeps your words without injected context, maps shell and patch steps, and ends turns', () => {
    const s = readCodexSession(codexSessionText(project), project, '2026-10-01T09:00:00.000Z')!
    expect(s.sessionId).toBe(CODEX_SESSION)
    expect(kinds(s.events)).toEqual(['user_text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'assistant_text', 'result'])
    expect(s.events[0]!.event).toEqual({ kind: 'user_text', text: 'Why is the build slow?' })
    expect(s.events[1]!.event).toMatchObject({ kind: 'tool_use', name: 'Shell', input: { command: 'npm run build -- --profile' } })
    expect(s.events[3]!.event).toMatchObject({ kind: 'tool_use', name: 'Edit' })
    expect(s.events.at(-1)!.event).toEqual({ kind: 'result', ok: true, durationMs: 13000 })
  })

  it('belongs only to the folder it was started in', () => {
    expect(readCodexSession(codexSessionText('/elsewhere'), project, '2026-10-01T09:00:00.000Z')).toBeUndefined()
  })
})

describe('listing', () => {
  it('lists both CLIs for the project, newest first, and nothing from other folders', () => {
    const home = mkdtempSync(join(tmpdir(), 'cockpit-import-'))
    writeImportHome(home, project)
    const all = listSessions(home, project)
    expect(all.map((s) => `${s.agent}:${s.sessionId}`).sort()).toEqual([`claude:${CLAUDE_SESSION}`, `codex:${CODEX_SESSION}`])
    expect(listSessions(home, '/nowhere')).toEqual([])
  })
})

 it('recovers real CLI sessions when a folder picker and provider use different symlink spellings', () => {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-alias-home-'))
  const root = mkdtempSync(join(tmpdir(), 'cockpit-alias-'))
  const actual = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-actual-')))
  const alias = join(root, 'project-link')
  symlinkSync(actual, alias)
  writeImportHome(home, actual)
  expect(listSessions(home, alias).map((s) => s.agent).sort()).toEqual(['claude', 'codex'])
  expect(listSessions(home, root)).toEqual([])
 })
