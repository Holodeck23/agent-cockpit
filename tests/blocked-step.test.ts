import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink, NormalizedEvent } from '../server/agents/types.ts'
import { blockedStepFollowUp, reportsBlockedSteps, stepLabel } from '../server/threads/blocked-step.ts'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import type { AgentCapabilities } from '../server/agents/capabilities/types.ts'
import { turnOutcomes } from '../server/threads/turn-outcomes.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema, type StoredEvent } from '../server/threads/types.ts'

// What agy 1.3.3 sends when its policy refuses a step (captured live): a refused tool, then a
// successful result with no text, and the session's denials so far.
const REFUSED = 'permission check failed for unsandboxed "find . -maxdepth 1 -type f": user denied permission to run command:\nfind . -maxdepth 1 -type f'
const refusedTurn = (n: number): NormalizedEvent[] => [
  { kind: 'tool_use', id: `t${n}`, name: 'run_command', input: { CommandLine: 'find . -maxdepth 1 -type f' } },
  { kind: 'tool_result', toolUseId: `t${n}`, content: REFUSED, isError: true },
  { kind: 'result', ok: true, text: '', durationMs: 4657, denied: [{ action: 'command', label: 'RunCommand' }] },
]
// The same refusal as agy 1.3.3 sends it through Cockpit's launch, captured live 2026-10-12: the
// step ends done with no output, and only the result's (per-turn, see the launcher) `denied` says so.
const refusedTurnLive = (n: number): NormalizedEvent[] => [
  { kind: 'tool_use', id: `t${n}`, name: 'run_command', input: { CommandLine: 'find . -maxdepth 1 -type f' } },
  { kind: 'tool_result', toolUseId: `t${n}`, content: '', isError: false },
  { kind: 'result', ok: true, text: '', durationMs: 7380, denied: [{ action: 'command', label: 'RunCommand' }] },
]
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup(settings = threadSettingsSchema.parse({ agent: 'antigravity', permissionMode: 'manual' }), agentId: 'antigravity' | 'claude' = 'antigravity') {
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-blocked-')))
  const fake = { emit: (() => undefined) as EventSink, sent: [] as string[], queues: false, launches: 0 }
  const launcher: Launcher = (_request, onEvent) => {
    fake.emit = onEvent
    fake.launches += 1
    let alive = true
    const session: AgentSession = {
      agent: agentId,
      send: (text) => { fake.sent.push(text) },
      queues: () => fake.queues,
      cancelQueued: () => Promise.resolve(false),
      respondApproval: () => undefined,
      interrupt: () => undefined,
      close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() },
      alive: () => alive,
    }
    return session
  }
  const manager = createThreadManager(store, { launchers: { antigravity: launcher, claude: launcher } })
  const meta = manager.create({ projectPath: '/tmp', settings, text: 'Run `find . -maxdepth 1 -type f` and tell me what it printed' })
  fake.emit({ kind: 'session', sessionId: meta.sessionId })
  const notes = (): StoredEvent[] => store.events(meta.id).filter((e) => e.event.kind === 'user_text' && e.event.fromCockpit)
  return { store, manager, meta, fake, notes, play: (events: NormalizedEvent[]) => events.forEach((e) => fake.emit(e)) }
}

describe('one follow-up after a blocked step (Antigravity)', () => {
  it('a refused, silent turn gets exactly one Cockpit note, recorded as Cockpit\'s', async () => {
    const { fake, notes, play } = setup()
    play(refusedTurn(1))
    expect(fake.sent).toHaveLength(1)
    await tick()
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[1]).toBe('Cockpit note: your last step (running `find . -maxdepth 1 -type f`) was blocked by this conversation\'s permission mode '
      + '(Configured permissions (Antigravity settings)), not by the user. Without running any more tools, tell the user in two or three sentences '
      + 'what you were trying to do, what was blocked, and what you can say without it.')
    expect(notes()).toHaveLength(1)
    expect(notes()[0]!.event).toMatchObject({ kind: 'user_text', fromCockpit: 'refused-step', text: fake.sent[1] })
    await tick()
    expect(fake.sent).toHaveLength(2)
  })

  it('the note\'s own silent end gets no second note, even with the session\'s old denials on its result', async () => {
    const { fake, notes, play } = setup()
    play(refusedTurn(1))
    await tick()
    play(refusedTurn(2))
    await tick()
    play([{ kind: 'result', ok: true, text: '', denied: [{ action: 'command', label: 'RunCommand' }] }])
    await tick()
    expect(fake.sent).toHaveLength(2)
    expect(notes()).toHaveLength(1)
  })

  it('a reply after the note ends it; your next refused turn may get its own note', async () => {
    const { fake, play } = setup()
    play(refusedTurn(1))
    await tick()
    play([{ kind: 'assistant_text', messageId: 'm1', text: 'I tried to list the files; the command was blocked.' }, { kind: 'result', ok: true, text: 'I tried…' }])
    await tick()
    expect(fake.sent).toHaveLength(2)
  })

  it('agy 1.3.3\'s live shape (a done step with no output, `denied` on the result) gets the same one note', async () => {
    const { fake, notes, play } = setup()
    play(refusedTurnLive(1))
    await tick()
    expect(fake.sent[1]).toMatch(/^Cockpit note: your last step \(running `find \. -maxdepth 1 -type f`\) was blocked/)
    play([{ kind: 'tool_use', id: 'x', name: 'run_command', input: { CommandLine: 'ls' } }, { kind: 'tool_result', toolUseId: 'x', content: '', isError: false },
      { kind: 'result', ok: true, text: '', denied: [{ action: 'command', label: 'RunCommand' }] }])
    await tick()
    expect(notes()).toHaveLength(1)
  })

  it('none after Stop', async () => {
    const { manager, meta, fake, play } = setup()
    manager.interrupt(meta.id)
    play(refusedTurn(1))
    await tick()
    expect(fake.sent).toHaveLength(1)
  })

  it('none while a message of yours waits in the queue', async () => {
    const { manager, meta, fake, play } = setup()
    fake.queues = true
    manager.send(meta.id, 'also this')
    play(refusedTurn(1))
    await tick()
    expect(fake.sent).toEqual([expect.any(String), 'also this'])
  })

  it('none when you send before Cockpit does', async () => {
    const { manager, meta, fake, play } = setup()
    play(refusedTurn(1))
    manager.send(meta.id, 'never mind')
    await tick()
    expect(fake.sent.filter((t) => t.startsWith('Cockpit note:'))).toHaveLength(0)
  })

  it('none with the setting off, or for another agent', async () => {
    const off = setup(threadSettingsSchema.parse({ agent: 'antigravity', permissionMode: 'manual', reportBlocked: false }))
    off.play(refusedTurn(1))
    await tick()
    expect(off.fake.sent).toHaveLength(1)
    const claude = setup(threadSettingsSchema.parse({ agent: 'claude' }), 'claude')
    claude.play(refusedTurn(1))
    await tick()
    expect(claude.fake.sent).toHaveLength(1)
  })

  it('resumes the session to ask when agy has already exited', async () => {
    const { fake, notes, play } = setup()
    play([...refusedTurn(1), { kind: 'exit', code: 0 }])
    await tick()
    expect(fake.launches).toBe(2)
    expect(notes()).toHaveLength(1)
  })
})

describe('Antigravity launcher: denials per turn', () => {
  it('passes on only what is new since the last result, since agy lists every denial of the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-agy-denied-'))
    const exe = join(dir, 'agy')
    // Each message gets a result; the first two turns are refused, the third is not; agy's list keeps growing.
    writeFileSync(exe, `#!/bin/sh
n=0
while IFS= read -r line; do
  n=$((n+1))
  case $n in
    1) d='[{"action":"command","display_name":"RunCommand"}]' ;;
    2) d='[{"action":"command","display_name":"RunCommand"},{"action":"read_file","display_name":"ReadFile"}]' ;;
    *) d='[{"action":"command","display_name":"RunCommand"},{"action":"read_file","display_name":"ReadFile"}]' ;;
  esac
  printf '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"","denied_actions":%s}}\\n' "$d"
done
`)
    chmodSync(exe, 0o755)
    const found: AgentCapabilities = { agent: 'antigravity', context: 'default', settings: {}, auth: { state: 'signed_in' }, models: { state: 'not_checked' },
      executable: { state: 'found', identity: { command: 'agy', path: exe, realpath: exe, fingerprint: 'f', version: '1.3.3' } } }
    const events: NormalizedEvent[] = []
    const session = launchAntigravity({ cwd: dir, permissionMode: 'manual' }, (e) => events.push(e), { check: async () => found })
    const results = () => events.filter((e): e is Extract<NormalizedEvent, { kind: 'result' }> => e.kind === 'result')
    for (const [n, text] of ['one', 'two', 'three'].entries()) {
      session.send(text)
      await expect.poll(() => results().length, { timeout: 10_000 }).toBe(n + 1)
    }
    await session.close()
    expect(results().map((r) => r.denied)).toEqual([[{ action: 'command', label: 'RunCommand' }], [{ action: 'read_file', label: 'ReadFile' }], undefined])
  })
})

describe('blockedStepFollowUp', () => {
  const at = (event: NormalizedEvent): StoredEvent => ({ ts: '2026-10-12T09:00:00.000Z', event })
  const ask: NormalizedEvent = { kind: 'user_text', text: 'list files' }
  const owed = (events: NormalizedEvent[]): string | undefined => blockedStepFollowUp(events.map(at), 'Ask before acting')

  it('not for a refusal you made on a Cockpit card, a turn with a reply, text on the result, or a failed result', () => {
    const card: NormalizedEvent[] = [ask, { kind: 'tool_use', id: 't', name: 'x', input: {} }, { kind: 'tool_result', toolUseId: 't', content: 'Denied from Agent Cockpit', isError: true }]
    expect(owed([...card, { kind: 'result', ok: true }])).toBeUndefined()
    const [, ...turn] = refusedTurn(1)
    expect(owed([ask, refusedTurn(1)[0]!, ...turn.slice(0, 1), { kind: 'assistant_text', messageId: 'm', text: 'Blocked.' }, { kind: 'result', ok: true }])).toBeUndefined()
    expect(owed([ask, ...refusedTurn(1).slice(0, 2), { kind: 'result', ok: true, text: 'said something' }])).toBeUndefined()
    expect(owed([ask, ...refusedTurn(1).slice(0, 2), { kind: 'result', ok: false }])).toBeUndefined()
  })

  it('with only this turn\'s `denied` to go on, names the turn\'s last step', () => {
    expect(owed([ask, ...refusedTurnLive(1)])).toContain('(running `find . -maxdepth 1 -type f`)')
    expect(owed([ask, { kind: 'result', ok: true, text: '', denied: [{ action: 'command', label: 'RunCommand' }] }])).toContain('(RunCommand)')
    expect(turnOutcomes([ask, ...refusedTurnLive(1)].map(at), 'antigravity').map((r) => r.outcome)).toEqual(['silent_after_refusal'])
  })

  it('looks only at the turn that just ended', () => {
    expect(owed([ask, ...refusedTurn(1), ask, { kind: 'result', ok: true }])).toBeUndefined()
    expect(owed([ask, ...refusedTurn(1)])).toContain('running `find . -maxdepth 1 -type f`')
  })

  it('labels a step by its command or path, else its name', () => {
    expect(stepLabel('run_command', { CommandLine: 'npm   run\ntypecheck' })).toBe('running `npm run typecheck`')
    expect(stepLabel('read_file', { AbsolutePath: '/p/notes.md' })).toBe('read_file /p/notes.md')
    expect(stepLabel('browser_open', {})).toBe('browser_open')
  })

  it('is on for Antigravity unless turned off, and off for the others', () => {
    expect(reportsBlockedSteps({ agent: 'antigravity' })).toBe(true)
    expect(reportsBlockedSteps({ agent: 'antigravity', reportBlocked: false })).toBe(false)
    expect(reportsBlockedSteps({ agent: 'codex', reportBlocked: true })).toBe(false)
  })
})

describe('the setting in the agent picker', () => {
  it('stores only "off", and only for Antigravity', async () => {
    const { settingsFromChoice } = await import('../web/src/components/AgentPicker.tsx')
    const agy = { agent: 'antigravity' as const, model: '', effort: '', permissionMode: 'manual' as const }
    expect(settingsFromChoice(agy)).not.toHaveProperty('reportBlocked')
    expect(settingsFromChoice({ ...agy, reportBlocked: false })).toMatchObject({ reportBlocked: false })
    expect(settingsFromChoice({ ...agy, agent: 'claude', reportBlocked: false })).not.toHaveProperty('reportBlocked')
    // Turning it back on drops the stored "off".
    expect(settingsFromChoice(agy, threadSettingsSchema.parse({ agent: 'antigravity', reportBlocked: false }))).not.toHaveProperty('reportBlocked')
  })
})
