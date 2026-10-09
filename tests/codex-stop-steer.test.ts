import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const sessions: AgentSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  vi.clearAllMocks()
})

async function runningSession(exitOnEnd = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  const requests: Array<{ id: number; method: string; params: { input?: unknown } }> = []
  const events: NormalizedEvent[] = []
  const reply = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')
  const notify = (method: string, params: unknown) => reply({ method, params })
  createInterface({ input: child.stdin }).on('line', (line) => {
    const request = JSON.parse(line)
    if (request.id === undefined || !request.method) return
    requests.push(request)
    // Hold steering replies so each test controls the race, through the real RPC client.
    if (request.method === 'turn/steer') return
    reply({ id: request.id, result: request.method === 'thread/start' ? { thread: { id: 'thread-1' } } : {} })
  })
  const exit = () => { child.emit('exit', 0); child.emit('close', 0) }
  child.stdin.on('end', () => { if (exitOnEnd) exit() })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const session = launchCodex({ cwd: process.cwd() }, (event) => events.push(event))
  sessions.push(session)
  session.send('first task')
  await vi.waitFor(() => expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1))
  notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
  session.send('pending follow-up')
  const steer = requests.find((r) => r.method === 'turn/steer')!
  expect(steer).toBeDefined()
  return {
    session, requests, events, exit,
    starts: () => requests.filter((r) => r.method === 'turn/start'),
    finish: (status: string) => notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status } }),
    async rejectSteer() {
      reply({ id: steer.id, error: { message: 'Turn is no longer active' } })
      await setImmediate()
    },
  }
}

describe('Codex steering reply after Stop', () => {
  it('starts the follow-up when the original turn ended naturally', async () => {
    const h = await runningSession()
    h.finish('completed')
    await h.rejectSteer()
    expect(h.starts()).toHaveLength(2)
    expect(h.starts()[1]!.params.input).toMatchObject([{ type: 'text', text: 'pending follow-up' }])
  })

  it('does not restart a stopped turn when its pending steering request fails', async () => {
    const h = await runningSession()
    h.session.interrupt()
    h.finish('interrupted')
    await h.rejectSteer()
    expect(h.requests.some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(h.starts()).toHaveLength(1)
    expect(h.events).toContainEqual({ kind: 'result', ok: false, stopped: true })
  })

  it('does not revive the old follow-up after a new message is sent following Stop', async () => {
    const h = await runningSession()
    h.session.interrupt()
    h.finish('interrupted')
    h.session.send('new deliberate task')
    await h.rejectSteer()
    expect(h.starts()).toHaveLength(2)
    expect(h.starts()[1]!.params.input).toMatchObject([{ type: 'text', text: 'new deliberate task' }])
  })

  it('does not try to start the pending follow-up after the session closes', async () => {
    const h = await runningSession()
    await h.session.close()
    await h.rejectSteer()
    expect(h.starts()).toHaveLength(1)
    expect(h.events.filter((e) => e.kind === 'error')).toEqual([])
  })

  it('invalidates the pending follow-up as soon as shutdown starts, before process exit', async () => {
    const h = await runningSession(false)
    const closing = h.session.close()
    try {
      await h.rejectSteer()
      expect(h.session.alive()).toBe(true)
      expect(h.starts()).toHaveLength(1)
      expect(h.events.filter((e) => e.kind === 'error')).toEqual([])
    } finally {
      h.exit()
      await closing
    }
  })
})
