import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowStore, expandWorkflows, resolveWorkflows } from '../server/workflows/store.ts'
import { createWorkflowRunner } from '../server/workflows/runner.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import type { EventSink } from '../server/agents/types.ts'
import { startServer, type RunningServer } from '../server/start.ts'

const setups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of setups.splice(0)) await close() })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-workflows-'))
  const store = createWorkflowStore(root)
  const threads = createThreadStore(root)
  const sessions: Array<{ emit: EventSink; text: string[] }> = []
  const launcher: Launcher = (_req, emit) => {
    const session = { emit, text: [] as string[] }; sessions.push(session)
    let alive = true
    return { agent: 'codex', alive: () => alive, send: (text) => { session.text.push(text) },
      respondApproval: () => undefined, interrupt: () => undefined,
      close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
  }
  const launchers = { claude: launcher, codex: launcher }
  const manager = createThreadManager(threads, { launchers })
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const runner = createWorkflowRunner(store, manager, threads, () => clock)
  setups.push(async () => { runner.close(); await manager.shutdown() })
  const save = (name = 'review', prompt = 'Review changes') => store.save({ projectPath: root, name, prompt, intervalMinutes: 5 })
  return { root, store, threads, manager, runner, sessions, save, launchers, advance: (ms: number) => { clock += ms } }
}

describe('workflows', () => {
  it('persists workflows, prevents name collisions, and pauses edited schedules', () => {
    const h = setup(); const w = h.save()
    expect(createWorkflowStore(h.root).get(w.id)).toEqual(w)
    expect(w.enabled).toBe(false)
    expect(() => h.save()).toThrow(/already exists/)
    h.runner.setEnabled(w.id, true)
    const edited = h.store.save({ ...w, prompt: 'Different instructions' }, w.id)
    expect(edited.enabled).toBe(false)
    expect(edited.nextRunAt).toBeNull()
    expect(() => h.store.save({ ...w, projectPath: '/another' }, w.id)).toThrow(/cannot move/)
  })

  it('expands nested instructions within the project and bounds cycles and size', () => {
    const h = setup(); h.save('inspect', 'Inspect the diff')
    h.save('report', '@workflow:inspect\nWrite findings')
    expect(expandWorkflows('@workflow:report', h.root, h.store)).toContain('Inspect the diff')
    expect(() => expandWorkflows('@workflow:report', '/other', h.store)).toThrow(/Unknown workflow/)
    h.save('cycle', '@workflow:cycle')
    expect(() => expandWorkflows('@workflow:cycle', h.root, h.store)).toThrow(/Circular/)
    h.save('large', 'x'.repeat(40_000))
    expect(() => expandWorkflows('@workflow:large '.repeat(6), h.root, h.store)).toThrow(/200,000/)
  })

  it('starts a normal conversation with expanded instructions and prevents overlaps', () => {
    const h = setup(); h.save('inspect', 'Inspect the diff'); const w = h.save('report', '@workflow:inspect')
    const t = h.runner.run(w.id)
    expect(t.workflowId).toBe(w.id)
    expect(t.workflowTrigger).toBe('manual')
    expect(h.sessions[0]?.text[0]).toContain('Inspect the diff')
    // The stored message is the workflow prompt as written, not its expansion.
    const stored = h.threads.events(t.id).filter(({ event }) => event.kind === 'user_text')
    expect(stored.map(({ event }) => event.kind === 'user_text' && event.text)).toEqual([h.store.get(w.id)?.prompt])
    expect(h.store.get(w.id)?.lastThreadId).toBe(t.id)
    expect(() => h.runner.run(w.id)).toThrow(/already has/)
    h.sessions[0]!.emit({ kind: 'result', ok: true })
    expect(h.runner.run(w.id).id).not.toBe(t.id)
  })

  it('lists each referenced workflow once, in order, with the instructions it used', () => {
    const h = setup(); h.save('inspect', 'Inspect the diff'); h.save('report', '@workflow:inspect\nWrite findings')
    const { used } = resolveWorkflows('@workflow:report then @workflow:inspect', h.root, h.store)
    expect(used).toEqual([{ name: 'report', prompt: '@workflow:inspect\nWrite findings' }, { name: 'inspect', prompt: 'Inspect the diff' }])
    expect(resolveWorkflows('plain text', h.root, h.store).used).toEqual([])
  })

  it('keeps what a run used even after the referenced workflow is edited', () => {
    const h = setup(); const inspect = h.save('inspect', 'Inspect the diff'); const w = h.save('report', '@workflow:inspect')
    const t = h.runner.run(w.id)
    h.store.save({ projectPath: h.root, name: 'inspect', prompt: 'Something else entirely' }, inspect.id)
    const [first] = h.threads.events(t.id).filter(({ event }) => event.kind === 'user_text')
    expect(first?.event).toMatchObject({ kind: 'user_text', text: '@workflow:inspect', workflows: [{ name: 'inspect', prompt: 'Inspect the diff' }] })
  })

  it('keeps scheduling after workflows.json could not be read for a while (M3)', async () => {
    const h = setup(); const w = h.save(); h.runner.setEnabled(w.id, true)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const file = join(h.root, 'workflows.json')
      const good = readFileSync(file, 'utf8')
      writeFileSync(file, '[{"broken"')
      h.advance(10 * 60_000)
      expect(() => h.runner.tick()).not.toThrow()
      expect(() => h.runner.tick()).not.toThrow()
      expect(errors).toHaveBeenCalledTimes(1)
      writeFileSync(file, good)
      h.runner.tick()
      expect(h.sessions).toHaveLength(1)
    } finally { errors.mockRestore() }
  })

  it('runs once after downtime, skips overlap including approvals, and persists next due time', () => {
    const h = setup(); const w = h.save(); h.runner.setEnabled(w.id, true)
    h.runner.tick(); expect(h.sessions).toHaveLength(0)
    h.advance(60 * 60_000); h.runner.tick(); h.runner.tick()
    expect(h.sessions).toHaveLength(1)
    expect(createWorkflowStore(h.root).get(w.id)?.nextRunAt).toBe('2026-01-01T01:05:00.000Z')
    h.sessions[0]!.emit({ kind: 'approval_request', requestId: '1', toolName: 'Write', input: {}, suggestions: [] })
    h.advance(5 * 60_000); h.runner.tick(); expect(h.sessions).toHaveLength(1)
    h.sessions[0]!.emit({ kind: 'result', ok: true })
    h.advance(5 * 60_000); h.runner.tick(); expect(h.sessions).toHaveLength(2)
  })

  it('runs a calendar schedule at its local time, once after downtime, and never with an interval too', () => {
    const h = setup()
    // 2026-01-01 is a Thursday; 09:00 in Vienna (CET, UTC+1) is 08:00 UTC.
    const w = h.store.save({ projectPath: h.root, name: 'morning', prompt: 'Brief me', calendar: { days: [1, 2, 3, 4, 5], time: '09:00', timeZone: 'Europe/Vienna' } })
    expect(() => h.store.save({ projectPath: h.root, name: 'both', prompt: 'x', intervalMinutes: 5, calendar: { days: [1], time: '09:00', timeZone: 'Europe/Vienna' } }))
      .toThrow('not both')
    expect(h.runner.setEnabled(w.id, true).nextRunAt).toBe('2026-01-01T08:00:00.000Z')
    h.advance(7 * 60 * 60_000); h.runner.tick(); expect(h.sessions).toHaveLength(0)
    h.advance(60 * 60_000); h.runner.tick(); expect(h.sessions).toHaveLength(1)
    expect(h.store.get(w.id)?.nextRunAt).toBe('2026-01-02T08:00:00.000Z')
    h.sessions[0]!.emit({ kind: 'result', ok: true })
    // Closed from Friday's run until Monday 12:00 Vienna: one late run then, next on Tuesday morning.
    h.advance(4 * 24 * 60 * 60_000 + 3 * 60 * 60_000); h.runner.tick(); h.runner.tick()
    expect(h.sessions).toHaveLength(2)
    expect(h.store.get(w.id)?.nextRunAt).toBe('2026-01-06T08:00:00.000Z')
  })

  it('pauses on failed scheduled runs and does not retry', () => {
    const h = setup(); const w = h.save(); h.runner.setEnabled(w.id, true)
    h.advance(5 * 60_000); h.runner.tick()
    h.sessions[0]!.emit({ kind: 'error', message: 'Rate limit reached' })
    expect(h.store.get(w.id)).toMatchObject({ enabled: false, nextRunAt: null, lastError: 'Rate limit reached' })
    h.advance(5 * 60_000); h.runner.tick(); expect(h.sessions).toHaveLength(1)
  })

  it('records invalid references and keeps archived workflows on disk without scheduling them', () => {
    const h = setup(); const w = h.save('bad', '@workflow:missing')
    expect(() => h.runner.run(w.id)).toThrow(/Unknown workflow/)
    expect(h.store.get(w.id)?.lastError).toContain('Unknown workflow')
    h.store.update(w.id, { archived: true, enabled: false, nextRunAt: null })
    expect(h.store.list()).toEqual([])
    expect(() => h.runner.run(w.id)).toThrow(/Unknown workflow/)
  })

  it('does not launch after shutdown', () => {
    const h = setup(); const w = h.save(); h.runner.setEnabled(w.id, true)
    h.runner.close(); h.advance(5 * 60_000); h.runner.tick()
    expect(h.sessions).toHaveLength(0)
    expect(() => h.runner.run(w.id)).toThrow(/shutting down/)
  })
})

describe('workflow HTTP integration', () => {
  it('creates, edits, schedules, runs and archives; expands references in normal messages', async () => {
    const h = setup()
    const server: RunningServer = await startServer({ port: 0, webDist: h.root, stateRoot: h.root, launchers: h.launchers })
    setups.push(() => server.close())
    const post = async (path: string, body: unknown = {}) => {
      const response = await fetch(`${server.url}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(response.ok).toBe(true)
      return (await response.json()).data
    }
    const w = await post('workflows', { projectPath: h.root, name: 'inspect', prompt: 'Inspect this project', intervalMinutes: 5 })
    expect((await post(`workflows/${w.id}/enabled`, { enabled: true })).enabled).toBe(true)
    const run = await post(`workflows/${w.id}/run`)
    expect(run.workflowId).toBe(w.id)
    expect(h.sessions[0]?.text[0]).toBe('Inspect this project')
    const t = await post('threads', { projectPath: h.root, text: '@workflow:inspect' })
    expect(h.sessions[1]?.text[0]).toContain('Inspect this project')
    await post(`threads/${t.id}/messages`, { text: 'Again @workflow:inspect' })
    expect(h.sessions[1]?.text[1]).toContain('Inspect this project')
    await post(`workflows/${w.id}/archive`)
    expect((await (await fetch(`${server.url}/api/workflows`)).json()).data).toEqual([])
  })
})
