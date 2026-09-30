import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../server/agents/claude/parse.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'
import type { StoredEvent } from '../server/threads/types.ts'
import { buildActivity, duration } from '../web/src/activity.ts'

const at = (second: number, event: NormalizedEvent): StoredEvent => ({
  ts: new Date(Date.UTC(2026, 8, 30, 10, 0, second)).toISOString(),
  event,
})

describe('buildActivity', () => {
  it('pairs each tool call with its result, in order, with timing', () => {
    const rows = buildActivity([
      at(0, { kind: 'user_text', text: 'Check the tests' }),
      at(1, { kind: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/p/package.json' } }),
      at(2, { kind: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }),
      at(3, { kind: 'tool_result', toolUseId: 'a', content: '{"name":"p"}', isError: false }),
      at(9, { kind: 'tool_result', toolUseId: 'b', content: '1 failing', isError: true }),
      at(10, { kind: 'assistant_text', messageId: 'm', text: 'One test fails.' }),
      at(10, { kind: 'result', ok: true }),
    ])
    expect(rows.map((r) => [r.label, r.state, r.startedAt.slice(17, 19), r.endedAt?.slice(17, 19)])).toEqual([
      ['Reading package.json', 'done', '01', '03'],
      ['Running npm test', 'error', '02', '09'],
    ])
    expect(rows[0]?.input).toContain('"file_path": "/p/package.json"')
    expect(rows[1]?.output).toBe('1 failing')
  })

  it('marks calls that never reported back as interrupted once the turn ends, not done', () => {
    const rows = buildActivity([
      at(0, { kind: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 100' } }),
      at(5, { kind: 'result', ok: false, stopped: true }),
      at(6, { kind: 'tool_result', toolUseId: 'a', content: 'late', isError: false }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'interrupted', endedAt: at(5, { kind: 'exit', code: 0 }).ts })
    expect(rows[0]?.output).toBeUndefined()
  })

  it('keeps an unanswered call running while the turn is still going', () => {
    const rows = buildActivity([at(0, { kind: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/p/a.ts' } })])
    expect(rows[0]).toMatchObject({ state: 'running' })
    expect(rows[0]?.endedAt).toBeUndefined()
  })

  it('shows an unanswered call as interrupted when no turn is running (e.g. after a restart)', () => {
    const rows = buildActivity([at(0, { kind: 'tool_use', id: 'a', name: 'Read', input: {} })], false)
    expect(rows[0]).toMatchObject({ state: 'interrupted' })
    expect(rows[0]?.endedAt).toBeUndefined()
  })

  it('treats a process exit, a new session and an agent switch as the end of open calls', () => {
    for (const end of [
      { kind: 'exit', code: 1 },
      { kind: 'session_boundary' },
      { kind: 'agent_switch', from: 'claude', to: 'codex' },
    ] satisfies NormalizedEvent[]) {
      const rows = buildActivity([at(0, { kind: 'tool_use', id: 'a', name: 'Read', input: {} }), at(1, end)])
      expect(rows[0]?.state).toBe('interrupted')
    }
  })

  it('ignores results for unknown calls and bounds long output', () => {
    const rows = buildActivity([
      at(0, { kind: 'tool_result', toolUseId: 'ghost', content: 'x', isError: false }),
      at(1, { kind: 'tool_use', id: 'a', name: 'mcp__cockpit__read_process_output', input: { id: 'proc-1' } }),
      at(2, { kind: 'tool_result', toolUseId: 'a', content: 'y'.repeat(10_000), isError: false }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: 'Read process output', label: 'Reading the proc-1 log' })
    expect(rows[0]?.output?.length).toBeLessThan(4100)
    expect(rows[0]?.output).toContain('6000 more characters')
  })

  it('renders a recorded Claude run with an approval', () => {
    const lines = readFileSync(new URL('./fixtures/claude-turn-approval.jsonl', import.meta.url), 'utf8').split('\n')
    const events = lines.flatMap(parseClaudeLine).map((event, index) => at(index % 60, event))
    const rows = buildActivity(events)
    const toolUses = events.filter((e) => e.event.kind === 'tool_use').length
    expect(rows).toHaveLength(toolUses)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.state !== 'running')).toBe(true)
  })
})

describe('duration', () => {
  const start = '2026-09-30T10:00:00.000Z'
  it('keeps sub-second and short calls readable', () => {
    expect(duration(start, Date.parse('2026-09-30T10:00:00.420Z'))).toBe('0.4s')
    expect(duration(start, Date.parse('2026-09-30T10:00:12.900Z'))).toBe('12s')
    expect(duration(start, Date.parse('2026-09-30T10:01:05.000Z'))).toBe('1:05')
  })
})
