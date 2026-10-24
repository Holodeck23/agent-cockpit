import reviewedConfig from './fixtures/codex-reviewed-config.json' with { type: 'json' }
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
// This RPC harness owns a synthetic provider; preflight has separate integration coverage.
vi.mock('../server/agents/codex/startup-preflight.ts', () => ({ codexStartupPreflight: async () => {} }))
const sessions: AgentSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  vi.clearAllMocks()
  vi.useRealTimers()
})

async function harness(holdStart = false) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  const events: NormalizedEvent[] = []
  const reply = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')
  const notify = (method: string, params: unknown) => reply({ method, params })
  createInterface({ input: child.stdin }).on('line', (line) => {
    const r = JSON.parse(line)
    if (!r.method || r.id === undefined) return
    requests.push(r)
    if (holdStart && r.method === 'turn/start') return
    if (r.method === 'thread/backgroundTerminals/terminate') return // Test controls confirmation.
    reply({ id: r.id, result: r.method === 'config/read' ? reviewedConfig : r.method === 'thread/start' ? { thread: { id: 'main' } } : {} })
  })
  child.stdin.on('end', () => { child.emit('exit', 0); child.emit('close', 0) })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const session = launchCodex({ cwd: process.cwd() }, (event) => events.push(event))
  sessions.push(session)
  session.send('first')
  await vi.waitFor(() => expect(requests.some((r) => r.method === 'turn/start')).toBe(true))
  const start = (threadId = 'main', id = 'turn-1') => notify('turn/started', { threadId, turn: { id } })
  if (!holdStart) start()
  return {
    session, requests, events, start, reply,
    command(threadId = 'main', turnId = 'turn-1', processId: string | null = 'terminal-1', id = 'cmd-1', method = 'item/started') {
      notify(method, { threadId, turnId, item: { type: 'commandExecution', id, processId, command: 'sleep 30', status: 'inProgress' } })
    },
    finish(threadId = 'main', id = 'turn-1') { notify('turn/completed', { threadId, turn: { id, status: 'interrupted' } }) },
    terminals: () => requests.filter((r) => r.method === 'thread/backgroundTerminals/terminate'),
    async confirm(index = 0, terminated = true, error?: string) {
      const r = requests.filter((r) => r.method === 'thread/backgroundTerminals/terminate')[index]!
      reply(error ? { id: r.id, error: { message: error } } : { id: r.id, result: { terminated } })
      await setImmediate()
    },
  }
}

describe('Codex Stop owns terminal cancellation', () => {
  it('keeps repeated startup Stop pending until Codex names the canceled turn', async () => {
    const h = await harness(true)
    h.session.interrupt()
    h.session.send('queued after Stop')
    h.session.interrupt()
    expect(h.events.some((e) => e.kind === 'result')).toBe(false)
    h.start()
    expect(h.requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1)
    h.finish()
    expect(h.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1)
    expect(h.events).toContainEqual({ kind: 'result', ok: false, stopped: true })
  })

  it('releases a deliberately queued follow-up if the canceled turn/start is rejected', async () => {
    const h = await harness(true)
    h.session.interrupt()
    h.session.send('deliberate follow-up')
    const request = h.requests.find((r) => r.method === 'turn/start')!
    h.reply({ id: request.id, error: { message: 'start rejected' } })
    await setImmediate()
    expect(h.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2)
  })

  it('terminates the model command by thread-scoped terminal ID and waits before reporting stopped or starting a follow-up', async () => {
    const h = await harness()
    h.command()
    h.session.interrupt()
    h.finish()
    h.session.send('deliberate follow-up')
    expect(h.requests.find((r) => r.method === 'initialize')!.params.capabilities).toEqual({ experimentalApi: true })
    expect(h.terminals().map((r) => r.params)).toEqual([{ threadId: 'main', processId: 'terminal-1' }])
    expect(h.events.some((e) => e.kind === 'result')).toBe(false)
    expect(h.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1)
    await h.confirm()
    expect(h.events).toContainEqual({ kind: 'result', ok: false, stopped: true })
    expect(h.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2)
    expect(h.requests.some((r) => ['command/exec/terminate', 'process/kill'].includes(r.method))).toBe(false)
  })

  it('cancels a command whose started notification arrives after Stop and deduplicates repeated Stop', async () => {
    const h = await harness()
    h.session.interrupt()
    h.command()
    h.session.interrupt()
    expect(h.terminals()).toHaveLength(1)
    await h.confirm()
    h.finish()
    expect(h.events).toContainEqual({ kind: 'result', ok: false, stopped: true })
  })

  it('stops active helper commands but leaves completed commands, old-turn terminals and unknown threads alone', async () => {
    const h = await harness()
    h.command('main', 'old-turn', 'old-terminal', 'old-cmd')
    h.command('unrelated', 'other-turn', 'other-terminal')
    h.command('main', 'turn-1', 'done-terminal', 'done-cmd')
    h.command('main', 'turn-1', 'done-terminal', 'done-cmd', 'item/completed')
    h.start('helper', 'helper-turn')
    h.command('helper', 'helper-turn', 'helper-terminal')
    h.command()
    h.session.interrupt()
    expect(h.terminals().map((r) => r.params)).toEqual([
      { threadId: 'main', processId: 'terminal-1' }, { threadId: 'helper', processId: 'helper-terminal' },
    ])
    await h.confirm(0)
    await h.confirm(1)
  })

  it.each([{ terminated: false }, { error: 'method unavailable' }])('keeps cancellation failure visible after the stopped result: %j', async ({ terminated, error }) => {
    const h = await harness()
    h.command()
    h.session.interrupt()
    h.finish()
    await h.confirm(0, terminated, error)
    expect(h.events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('may still be running') })
  })

  it('bounds an unanswered terminal cancellation and reports the uncertainty', async () => {
    const h = await harness()
    vi.useFakeTimers()
    h.command()
    h.session.interrupt()
    h.finish()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('timed out') })
  })

  it('does not terminate a background terminal after its command item has already completed', async () => {
    const h = await harness()
    h.command()
    h.command('main', 'turn-1', 'terminal-1', 'cmd-1', 'item/completed')
    h.session.interrupt()
    h.finish()
    expect(h.terminals()).toHaveLength(0)
    expect(h.events).toContainEqual({ kind: 'result', ok: false, stopped: true })
  })
})
