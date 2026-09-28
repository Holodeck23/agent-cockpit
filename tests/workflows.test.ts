import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowStore, expandWorkflows } from '../server/workflows/store.ts'
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
    return { agent: 'codex', alive: () => alive, send: (text) => { session.text.push(text); emit({ kind: 'user_text', text }) },
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
    expect(h.store.get(w.id)?.lastThreadId).toBe(t.id)
    expect(() => h.runner.run(w.id)).toThrow(/already has/)
    h.sessions[0]!.emit({ kind: 'result', ok: true })
    expect(h.runner.run(w.id).id).not.toBe(t.id)
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
