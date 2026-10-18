import { describe, expect, it } from 'vitest'
import { assessCodexStopRecords, assessCodexHookEvents } from '../scripts/lib/w13-codex-stop-observation'

const fixture = (): any[] => [false, true].flatMap((active, i) => ['a', 'b'].map((label, j) => ({
  label, pid: 100 + i * 2 + j,
  input: { hook_event_name: 'Stop', session_id: 'native-session', turn_id: 'native-turn', stop_hook_active: active },
})))
const assess = (rows: unknown): unknown[] => assessCodexStopRecords(rows, 'native-session', 'native-turn')
describe('native Stop correction observation boundary', () => {
  it('permits concurrent hook ordering without inventing cycle identity', () => {
    const rows = fixture().reverse()
    const summary = assess(rows)
    expect(summary).toHaveLength(4)
    expect(JSON.stringify(summary)).not.toContain('cycleId')
    expect(JSON.stringify(summary)).not.toContain('100')
  })
  it('requires both hooks in each correction state', () => {
    const rows = fixture(); rows[3] = rows[2]
    expect(() => assess(rows)).toThrow('Duplicate')
  })
  it.each(['session_id', 'turn_id', 'hook_event_name', 'stop_hook_active'])('rejects unbound or malformed %s', (key) => {
    const rows = fixture(); rows[0].input[key] = 'untrusted'
    expect(() => assess(rows)).toThrow()
  })
  it.each([undefined, [], fixture().slice(1), [...fixture(), fixture()[0]]])('rejects missing or extra callbacks', (rows) => {
    expect(() => assess(rows)).toThrow()
  })
  it('rejects unknown handlers', () => {
    const rows = fixture(); rows[0].label = 'foreign'
    expect(() => assess(rows)).toThrow()
  })
  it('does not expose arbitrary raw native input contents', () => {
    const rows = fixture(); rows[0].input.last_assistant_message = 'private fixture text'
    expect(JSON.stringify(assess(rows))).not.toContain('private fixture text')
  })
})

const events = (): any[] => [false, true].flatMap((correction) => ['hook/started', 'hook/completed'].flatMap((method) => [0, 1].map((i) => ({
  method, params: { threadId: 's', turnId: 't', run: { id: `handler:${i}:private/path`, eventName: 'stop',
    status: method === 'hook/started' ? 'running' : !correction && i === 0 ? 'blocked' : 'completed' } },
}))))
describe('pinned singular hook protocol event assessment', () => {
  it('shows reused per-handler IDs without exposing their path-bearing contents', () => {
    const summary = assessCodexHookEvents(events(), 's', 't')
    expect(summary).toMatchObject({ nativeHookEvents: 8, distinctRunIds: 2, runIdOccurrences: [2, 2], runIdsAreCycleIds: false })
    expect(JSON.stringify(summary)).not.toContain('private/path')
  })
  it('rejects an incomplete stream', () => expect(() => assessCodexHookEvents(events().slice(1), 's', 't')).toThrow())
  it('rejects native events from another turn', () => expect(() => assessCodexHookEvents(events(), 's', 'other')).toThrow())
  it('rejects unmatched start/completion IDs', () => {
    const rows = events(); rows[0].params.run.id = 'foreign'
    expect(() => assessCodexHookEvents(rows, 's', 't')).toThrow()
  })
})
