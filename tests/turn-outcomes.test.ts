import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { readClaudeSession } from '../server/import/sessions.ts'
import { tokensInOf, turnOutcomes } from '../server/threads/turn-outcomes.ts'
import type { StoredEvent } from '../server/threads/types.ts'
import { CLAUDE_SESSION, claudeSessionText } from '../scripts/lib/import-fixtures.ts'

let clock = 0
const at = (event: NormalizedEvent, ts?: string): StoredEvent => ({ ts: ts ?? new Date(Date.UTC(2026, 9, 12, 9, 0, clock++)).toISOString(), event })
const ask = (text = 'Do the thing', extra: Partial<Extract<NormalizedEvent, { kind: 'user_text' }>> = {}): StoredEvent => at({ kind: 'user_text', text, ...extra })
const say = (text: string): StoredEvent => at({ kind: 'assistant_text', messageId: `m${clock}`, text })
const tool = (id: string): StoredEvent => at({ kind: 'tool_use', id, name: 'run_command', input: { CommandLine: 'find .' } })
const toolResult = (id: string, content: string, isError = true): StoredEvent => at({ kind: 'tool_result', toolUseId: id, content, isError })
const done = (extra: Partial<Extract<NormalizedEvent, { kind: 'result' }>> = {}): StoredEvent => at({ kind: 'result', ok: true, runId: `r${clock}`, durationMs: 1200, ...extra })
const boundary = (): StoredEvent => at({ kind: 'session_boundary', generation: 1 })
const REFUSED = 'permission check failed for unsandboxed "find . -maxdepth 1 -type f": user denied permission to run command:\nfind . -maxdepth 1 -type f'

const outcomes = (events: StoredEvent[], agent: Parameters<typeof turnOutcomes>[1] = 'antigravity') => turnOutcomes(events, agent).map((r) => r.outcome)

describe('turn outcomes', () => {
  it('a reply ends a turn as concluded, "Question:" and "Blocked:" as their own outcomes', () => {
    expect(outcomes([boundary(), ask(), say('Done: added the toggle.'), done(),
      ask(), say('Question: which header?'), done(),
      ask(), tool('t1'), say('Blocked: the network is down.'), done()])).toEqual(['concluded', 'question', 'blocked'])
  })

  it('a turn whose last work is a tool call, or whose message is empty, is silent', () => {
    expect(outcomes([boundary(), ask(), say('Looking.'), tool('t1'), toolResult('t1', 'a.txt', false), done(), ask(), say('  '), done()])).toEqual(['silent', 'silent'])
  })

  it('silent after a refused step, in the agent\'s words or after a card you denied', () => {
    expect(outcomes([boundary(), ask(), tool('t1'), toolResult('t1', REFUSED), done(),
      ask(), at({ kind: 'approval_request', requestId: 'a1', toolName: 'Bash', input: {}, suggestions: [] }),
      at({ kind: 'approval_resolved', requestId: 'a1', behavior: 'deny' }), tool('t2'), toolResult('t2', 'Permission denied'), done()]))
      .toEqual(['silent_after_refusal', 'silent_after_refusal'])
  })

  it('an OS "Permission denied" from a command that ran is not a refusal', () => {
    expect(outcomes([boundary(), ask(), tool('t1'), toolResult('t1', 'ls: /root: Permission denied'), done()])).toEqual(['silent'])
  })

  it('stopped and failed come first, whatever was said', () => {
    expect(outcomes([boundary(), ask(), say('Starting.'), done({ stopped: true }),
      ask(), say('Hm.'), done({ ok: false }),
      ask(), at({ kind: 'error', message: 'agy crashed' }),
      ask(), tool('t1'), at({ kind: 'exit', code: 1 })])).toEqual(['stopped', 'failed', 'failed', 'failed'])
  })

  it('a silent refused turn whose Cockpit follow-up got a reply is one recovered turn', () => {
    const rows = turnOutcomes([boundary(), ask(), tool('t1'), toolResult('t1', REFUSED), done(),
      ask('Cockpit note: …', { fromCockpit: 'refused-step' }), say('I tried to list files; the step was blocked.'), done()], 'antigravity')
    expect(rows.map((r) => r.outcome)).toEqual(['recovered'])
  })

  it('a follow-up that also went silent leaves the turn silent after refusal', () => {
    expect(outcomes([boundary(), ask(), tool('t1'), toolResult('t1', REFUSED), done(),
      ask('Cockpit note: …', { fromCockpit: 'refused-step' }), done()])).toEqual(['silent_after_refusal'])
  })

  it('counts tools, reads Antigravity\'s per-turn input tokens and the duration', () => {
    const [row] = turnOutcomes([boundary(), ask(), tool('t1'), toolResult('t1', 'ok', false), tool('t2'), toolResult('t2', 'ok', false),
      at({ kind: 'usage', limitType: 'last_turn', status: '116,201 tokens (109,031 in, 7,170 out)' }), say('Two files.'), done({ durationMs: 4200 })], 'antigravity')
    expect(row).toMatchObject({ agent: 'antigravity', tools: 2, tokensIn: 109031, durationMs: 4200, imported: false, outcome: 'concluded' })
    expect(tokensInOf('1,000 tokens')).toBeUndefined()
  })

  it('attributes turns to the agent that ran them across a switch', () => {
    const rows = turnOutcomes([boundary(), ask(), say('Claude here.'), done(), at({ kind: 'agent_switch', from: 'claude', to: 'codex' }),
      boundary(), ask(), say('Codex here.'), done()], 'codex')
    expect(rows.map((r) => r.agent)).toEqual(['claude', 'codex'])
  })

  it('a turn still running has no row; a queued message does not start one', () => {
    expect(outcomes([boundary(), ask(), say('On it.'), ask('also this', { queuedId: 'q1' }), say('Done.'), done(), ask(), tool('t1')])).toEqual(['concluded'])
  })

  it('a message steering a running turn joins it: one turn, one ending', () => {
    expect(outcomes([boundary(), ask('first'), tool('t1'), ask('also check the tests'), tool('t2'), ask('and the docs'), say('Both done.'), done()], 'codex'))
      .toEqual(['concluded'])
  })

  it('marks imported turns: the importer\'s synthetic ends, and older unmarked ones', () => {
    const imported = readClaudeSession(claudeSessionText('/p'), CLAUDE_SESSION, '/p', '2026-09-30T10:00:00.000Z').events
    expect(imported.filter((e) => e.event.kind === 'result').every((e) => e.event.kind === 'result' && e.event.synthetic)).toBe(true)
    expect(turnOutcomes(imported, 'claude').every((r) => r.imported)).toBe(true)

    // An import from before the marker: a bare success at the same time as the next message, and
    // a bare success before the conversation's first agent process. Live turns after it count.
    const legacy = [ask('one'), tool('t1'), at({ kind: 'result', ok: true }, '2026-10-10T06:10:12.676Z'), at({ kind: 'user_text', text: 'two' }, '2026-10-10T06:10:12.676Z'),
      tool('t2'), at({ kind: 'result', ok: true }, '2026-10-10T06:11:00.000Z'), boundary(), ask('three'), say('Live reply.'), done()]
    expect(turnOutcomes(legacy, 'codex').map((r) => [r.outcome, r.imported])).toEqual([['silent', true], ['silent', true], ['concluded', false]])

    // Codex's own turn ends come through with their durations; before the first agent process they are still imported.
    const codex = [ask('one'), say('Reply.'), done({ runId: undefined, durationMs: 13000 }), boundary(), ask('two'), say('Live.'), done()]
    expect(turnOutcomes(codex, 'codex').map((r) => r.imported)).toEqual([true, false])
    // With no agent process yet, only the import signs count.
    const unmarked = [ask('one'), tool('t1'), at({ kind: 'result', ok: true }, '2026-10-10T06:10:12.676Z'), at({ kind: 'user_text', text: 'two' }, '2026-10-10T06:10:12.676Z'),
      say('Reply.'), done({ runId: undefined, durationMs: 13000 })]
    expect(turnOutcomes(unmarked, 'codex').map((r) => r.imported)).toEqual([true, false])
  })

  it('a live bare result without the import signs is not imported', () => {
    expect(turnOutcomes([boundary(), ask(), tool('t1'), at({ kind: 'result', ok: true })], 'claude')[0]!.imported).toBe(false)
  })
})

describe('report:turns', () => {
  it('prints one row per agent from a state folder, leaving imported turns out', () => {
    const home = mkdtempSync(join(tmpdir(), 'cockpit-report-'))
    const write = (id: string, agent: string, events: StoredEvent[]): void => {
      mkdirSync(join(home, 'threads', id), { recursive: true })
      writeFileSync(join(home, 'threads', id, 'meta.json'), JSON.stringify({ id, settings: { agent } }))
      writeFileSync(join(home, 'threads', id, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    }
    write('aaaaaaaa-0000-4000-8000-000000000001', 'antigravity', [boundary(), ask(), tool('t1'), toolResult('t1', REFUSED), done(), ask(), say('Fine.'), done()])
    write('aaaaaaaa-0000-4000-8000-000000000002', 'codex', [ask(), tool('t1'), at({ kind: 'result', ok: true, synthetic: true }), boundary(), ask(), say('Hi.'), done()])
    const run = (...extra: string[]): string => execFileSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '../scripts/report-turns.ts'), ...extra],
      { env: { ...process.env, COCKPIT_HOME: home }, encoding: 'utf8' })
    const table = run().split('\n')
    expect(table[0]).toMatch(/^agent\s+turns\s+concluded %\s+question\s+blocked\s+silent_after_refusal\s+recovered\s+silent\s+stopped\s+failed\s+median tokensIn\s+median ms$/)
    expect(table[1]).toMatch(/^antigravity\s+2\s+50\s+0\s+0\s+1\s+0\s+0\s+0\s+0\s+-\s+1200$/)
    expect(table[2]).toMatch(/^codex\s+1\s+100\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+-\s+1200$/)
    expect(table.join('\n')).toContain('2 conversations, 3 live turns, 1 imported turns left out')
    const json = run('--json').trim().split('\n').map((l) => JSON.parse(l) as { imported: boolean })
    expect(json).toHaveLength(4)
    expect(json.filter((r) => r.imported)).toHaveLength(1)
  })
})
