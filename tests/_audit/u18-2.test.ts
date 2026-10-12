import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { StoredEvent } from '../../server/threads/types.ts'
import { buildActivity } from '../../web/src/activity.ts'

// u18-2: a conversation can have one agent per workspace working at once (W12-15), and every stored
// event is tagged with the workspace of the session that produced it. buildActivity keeps one `open`
// map keyed by tool id only, and a `result` / `exit` / `session_boundary` / `agent_switch` event from
// ANY workspace flips every open row to 'interrupted' and clears the map. So workspace B finishing a
// turn marks workspace A's still-running tool as Interrupted, and A's later tool_result is dropped.
// CORRECT behaviour: an ending event only closes the calls of its own workspace.

const at = (second: number, workspaceId: string, event: NormalizedEvent): StoredEvent => ({
  ts: new Date(Date.UTC(2026, 9, 10, 10, 0, second)).toISOString(),
  event,
  workspaceId,
})

const A = 'ws-main'
const B = 'ws-worktree'

describe('u18-2 buildActivity across concurrent workspaces', () => {
  it('keeps workspace A\'s running tool running when workspace B\'s turn ends', () => {
    const rows = buildActivity([
      at(0, A, { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'npm run build' } }),
      at(1, B, { kind: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/p/b.ts' } }),
      at(2, B, { kind: 'tool_result', toolUseId: 'toolu_B', content: 'ok', isError: false }),
      at(3, B, { kind: 'result', ok: true }),
    ])
    expect(rows.map((r) => [r.id, r.state])).toEqual([['toolu_A', 'running'], ['toolu_B', 'done']])
    expect(rows[0]?.endedAt).toBeUndefined()
  })

  it('still records workspace A\'s tool_result after workspace B\'s turn ended', () => {
    const rows = buildActivity([
      at(0, A, { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'npm run build' } }),
      at(1, B, { kind: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/p/b.ts' } }),
      at(2, B, { kind: 'tool_result', toolUseId: 'toolu_B', content: 'ok', isError: false }),
      at(3, B, { kind: 'result', ok: true }),
      at(9, A, { kind: 'tool_result', toolUseId: 'toolu_A', content: 'build succeeded', isError: false }),
    ])
    expect(rows[0]).toMatchObject({ id: 'toolu_A', state: 'done', output: 'build succeeded' })
    expect(rows[0]?.endedAt).toBe(at(9, A, { kind: 'exit', code: 0 }).ts)
  })

  it('does not interrupt workspace A\'s tool when workspace B\'s process exits', () => {
    const rows = buildActivity([
      at(0, A, { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'sleep 100' } }),
      at(1, B, { kind: 'exit', code: 1 }),
    ])
    expect(rows[0]).toMatchObject({ id: 'toolu_A', state: 'running' })
  })

  it('pairs a result that is not tagged with a workspace yet (just streamed in) with its call by id', () => {
    const untagged = (second: number, event: NormalizedEvent): StoredEvent => ({ ts: at(second, A, event).ts, event })
    const rows = buildActivity([
      at(0, A, { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'ls' } }),
      at(1, B, { kind: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/p/b.ts' } }),
      untagged(2, { kind: 'tool_result', toolUseId: 'toolu_A', content: 'files', isError: false }),
    ])
    expect(rows.map((r) => [r.id, r.state])).toEqual([['toolu_A', 'done'], ['toolu_B', 'running']])
  })

  it('an agent switch ends every workspace\'s open tools', () => {
    const rows = buildActivity([
      at(0, A, { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'ls' } }),
      at(1, B, { kind: 'tool_use', id: 'toolu_B', name: 'Read', input: { file_path: '/p/b.ts' } }),
      { ts: at(2, A, { kind: 'exit', code: 0 }).ts, event: { kind: 'agent_switch', from: 'claude', to: 'codex' } },
    ])
    expect(rows.map((r) => r.state)).toEqual(['interrupted', 'interrupted'])
  })

  it('control: an ending event in the SAME workspace still interrupts that workspace\'s open tool', () => {
    const rows = buildActivity([
      at(0, A, { kind: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'sleep 100' } }),
      at(5, A, { kind: 'result', ok: false, stopped: true }),
    ])
    expect(rows[0]).toMatchObject({ state: 'interrupted' })
  })
})
