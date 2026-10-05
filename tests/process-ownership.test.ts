import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSession } from '../server/agents/types.ts'
import { createProcessRunner, ProcessConflictError, type ProcessInfo, type ProcessOwner, type ProcessRunner } from '../server/processes/runner.ts'
import { startServer } from '../server/start.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const folder = (): string => mkdtempSync(join(tmpdir(), 'cockpit-own-'))
const LONG = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`
const OTHER = `"${process.execPath}" -e "setInterval(() => {}, 999)"`
const mine: ProcessOwner = { kind: 'conversation', threadId: 't1', title: 'Fix the login', runId: 'run-1' }
const theirs: ProcessOwner = { kind: 'conversation', threadId: 't2', title: 'Write docs' }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (test()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

describe('process ownership and reuse (K1, W7-06)', () => {
  let runner: ProcessRunner | undefined
  afterEach(async () => { await runner?.shutdown(); runner = undefined })

  it('a second conversation reuses the same command and sees the original owner; another folder is independent; another command conflicts', () => {
    runner = createProcessRunner()
    const app = folder()
    const worktree = folder()
    const first = runner.start({ projectPath: app, command: LONG, name: 'dev' }, mine)
    expect(first.process.owner).toEqual(mine)
    const second = runner.start({ projectPath: app, command: LONG, name: 'dev' }, theirs)
    expect(second.reused).toBe(true)
    expect(second.process.id).toBe(first.process.id)
    expect(second.process.owner).toEqual(mine)
    expect(second.process.sharedWith).toEqual([{ threadId: 't2', title: 'Write docs' }])
    // Asking again does not list the same user twice; the owner is never listed as a user.
    runner.start({ projectPath: app, command: LONG, name: 'dev' }, theirs)
    runner.start({ projectPath: app, command: LONG, name: 'dev' }, mine)
    expect(runner.get(first.process.id)?.sharedWith).toHaveLength(1)

    const elsewhere = runner.start({ projectPath: worktree, command: LONG, name: 'dev' }, theirs)
    expect(elsewhere.reused).toBe(false)
    expect(elsewhere.process.owner).toEqual(theirs)

    expect(() => runner!.start({ projectPath: app, command: OTHER, name: 'dev' }, theirs)).toThrow(ProcessConflictError)
    expect(runner.list(app).filter((p) => p.status === 'running')).toHaveLength(1)
  })

  it('restart keeps folder, name, command, owner and users, with a new process ID', async () => {
    runner = createProcessRunner({ graceMs: 300 })
    const app = folder()
    const first = runner.start({ projectPath: app, command: LONG, name: 'dev' }, mine).process
    runner.start({ projectPath: app, command: LONG, name: 'dev' }, theirs)
    const again = await runner.restart(first.id)
    expect(again.id).not.toBe(first.id)
    expect(again).toMatchObject({ projectPath: app, name: 'dev', command: LONG, owner: mine, sharedWith: [{ threadId: 't2', title: 'Write docs' }], status: 'running' })
  })

  it('an unowned start is a project process, never assigned to a conversation', () => {
    runner = createProcessRunner()
    expect(runner.start({ projectPath: folder(), command: LONG }).process.owner).toEqual({ kind: 'project' })
  })
})

describe('finished view and deleting an owner (K2, W7-07)', () => {
  let runner: ProcessRunner | undefined
  afterEach(async () => { await runner?.shutdown(); runner = undefined })

  it('a finished process leaves the active list; Clear finished drops only finished rows and stops nothing', async () => {
    runner = createProcessRunner()
    const app = folder()
    const seen: ProcessInfo[] = []
    runner.subscribe((info) => seen.push(info))
    const quick = runner.start({ projectPath: app, command: 'exit 0', name: 'once' }, mine).process
    const server = runner.start({ projectPath: app, command: LONG, name: 'dev' }, mine).process
    await until(() => runner!.get(quick.id)?.status === 'exited')
    expect(runner.ownedBy('t1').map((p) => p.id)).toEqual([server.id])
    expect(runner.clearFinished(app)).toBe(1)
    expect(runner.list(app).map((p) => p.id)).toEqual([server.id])
    expect(seen.find((p) => p.id === quick.id && p.cleared)).toBeDefined()
    expect(alive(server.pid!)).toBe(true)
  })

  it('stop owned processes stops only the owner’s; keep makes them project processes, never another conversation’s', async () => {
    runner = createProcessRunner({ graceMs: 300 })
    const app = folder()
    const owned = runner.start({ projectPath: app, command: LONG, name: 'dev' }, mine).process
    runner.start({ projectPath: app, command: LONG, name: 'dev' }, theirs)
    const other = runner.start({ projectPath: app, command: LONG, name: 'docs' }, theirs).process
    const kept = await runner.release('t1', 'keep')
    expect(kept[0]).toMatchObject({ id: owned.id, owner: { kind: 'project', formerly: 'Fix the login' }, sharedWith: [{ threadId: 't2', title: 'Write docs' }], status: 'running' })
    expect(runner.ownedBy('t1')).toEqual([])

    const second = runner.start({ projectPath: folder(), command: LONG, name: 'api' }, mine).process
    await runner.release('t1', 'stop')
    expect(runner.get(second.id)?.status).toBe('exited')
    expect(alive(other.pid!)).toBe(true)
    expect(runner.get(other.id)?.owner).toEqual(theirs)
  })

  it('DELETE refuses while the conversation owns running processes, then honours Stop or Keep', async () => {
    const root = folder()
    const launcher: Launcher = () => ({ agent: 'claude', alive: () => true, send() {}, respondApproval() {}, interrupt() {}, close: async () => {} } as AgentSession)
    const server = await startServer({ port: 0, stateRoot: folder(), webDist: root, launchers: { claude: launcher, codex: launcher } })
    const json = { 'content-type': 'application/json' }
    try {
      await fetch(`${server.url}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: root }) })
      const create = async (title: string): Promise<string> => (await (await fetch(`${server.url}/api/threads`, { method: 'POST', headers: json,
        body: JSON.stringify({ projectPath: root, title, text: 'go', settings: { agent: 'claude' } }) })).json()).data.id
      const a = await create('Keeper')
      const b = await create('Stopper')
      const keptProc = server.processes.start({ projectPath: root, command: LONG, name: 'dev' }, { kind: 'conversation', threadId: a, title: 'Keeper' }).process
      const stoppedProc = server.processes.start({ projectPath: root, command: LONG, name: 'api' }, { kind: 'conversation', threadId: b, title: 'Stopper' }).process
      const del = (id: string, body: unknown) => fetch(`${server.url}/api/threads/${id}`, { method: 'DELETE', headers: json, body: JSON.stringify(body) })

      const refused = await del(a, {})
      expect(refused.status).toBe(409)
      expect((await refused.json()).error).toMatch(/owns running processes \(dev\)/)
      expect((await del(a, { processes: 'keep' })).status).toBe(200)
      expect(server.processes.get(keptProc.id)).toMatchObject({ status: 'running', owner: { kind: 'project', formerly: 'Keeper' } })
      expect((await del(b, { processes: 'stop' })).status).toBe(200)
      expect(server.processes.get(stoppedProc.id)?.status).toBe('exited')
    } finally {
      await server.close()
    }
  })
})

describe('Stop then Quit (ID-06)', () => {
  it('owned activity ends within bounds, the control grant is revoked, and an unrelated process survives', async () => {
    const issued = new Set<string>()
    let closed = 0
    const launcher: Launcher = () => ({ agent: 'claude', alive: () => closed === 0, send() {}, respondApproval() {}, interrupt() {}, close: async () => { closed++ } } as AgentSession)
    const store = createThreadStore(folder())
    const manager = createThreadManager(store, {
      launchers: { claude: launcher, codex: launcher },
      mcp: (grant) => { issued.add(grant.threadId); return { launch: { command: 'x', args: [], secretEnv: {} }, release: () => issued.delete(grant.threadId) } },
    } as Parameters<typeof createThreadManager>[1])
    const runner = createProcessRunner({ graceMs: 300 })
    const app = folder()
    const meta = manager.create({ projectPath: app, settings: threadSettingsSchema.parse({}), text: 'go' })
    expect(issued.has(meta.id)).toBe(true)
    const owned = runner.start({ projectPath: app, command: LONG, name: 'dev' }, { kind: 'conversation', threadId: meta.id, title: meta.title }).process
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    try {
      manager.interrupt(meta.id)
      const started = Date.now()
      await Promise.all([manager.shutdown(), runner.shutdown()])
      expect(Date.now() - started).toBeLessThan(5000)
      expect(closed).toBe(1)
      expect(issued.has(meta.id)).toBe(false)
      expect(alive(owned.pid!)).toBe(false)
      expect(alive(unrelated.pid!)).toBe(true)
    } finally {
      unrelated.kill('SIGKILL')
    }
  })
})

describe('a crash with a persisted PID (ID-07)', () => {
  it('recovery reports the process as interrupted and never signals a PID that now belongs to another program', async () => {
    const state = folder()
    const ledgerFile = join(state, 'processes.json')
    const app = folder()
    // The crashed launch recorded a process; its number now belongs to an unrelated program.
    const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, processes: [{ id: 'proc-old-1', name: 'dev', command: 'npm run dev', projectPath: app, pid: reused.pid,
      startedAt: '2026-10-05T08:00:00.000Z', owner: mine }] }))
    const runner = createProcessRunner({ ledgerFile, graceMs: 200 })
    try {
      const [recovered] = runner.list(app)
      expect(recovered).toMatchObject({ id: 'proc-old-1', status: 'exited', interrupted: true, pid: reused.pid, owner: mine })
      expect(runner.read('proc-old-1').lines[0]?.text).toMatch(/quit unexpectedly.*does not stop it/)
      await runner.stop('proc-old-1')
      await runner.shutdown()
      expect(alive(reused.pid!)).toBe(true)
      // Recovery started nothing again, and the ledger no longer lists it as running.
      expect(runner.list(app).filter((p) => p.status === 'running')).toEqual([])
      expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).processes).toEqual([])
    } finally {
      reused.kill('SIGKILL')
    }
  })

  it('an unreadable ledger is left exactly as found and not rewritten', async () => {
    const state = folder()
    const ledgerFile = join(state, 'processes.json')
    writeFileSync(ledgerFile, '{ broken')
    const runner = createProcessRunner({ ledgerFile })
    runner.start({ projectPath: folder(), command: LONG, name: 'dev' })
    await runner.shutdown()
    expect(readFileSync(ledgerFile, 'utf8')).toBe('{ broken')
  })

  it('records running processes and drops them when they end', async () => {
    const ledgerFile = join(folder(), 'processes.json')
    const runner = createProcessRunner({ ledgerFile, graceMs: 200 })
    const started = runner.start({ projectPath: folder(), command: LONG, name: 'dev' }, mine).process
    expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).processes).toEqual([expect.objectContaining({ id: started.id, pid: started.pid, owner: mine })])
    await runner.shutdown()
    await until(() => JSON.parse(readFileSync(ledgerFile, 'utf8')).processes.length === 0)
  })
})
