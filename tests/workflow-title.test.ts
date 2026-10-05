import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { createWorkflowRunner } from '../server/workflows/runner.ts'
import { workflowTitle } from '../server/workflows/title.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { startServer } from '../server/start.ts'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

const emits: Array<(event: { kind: 'result'; ok: boolean }) => void> = []
const launcher: Launcher = (_req, emit) => {
  emits.push(emit)
  let alive = true
  return { agent: 'claude', alive: () => alive, send: () => {}, respondApproval: () => undefined, interrupt: () => undefined,
    close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
}

describe('A12 workflow conversation titles (W7-01)', () => {
  it('opening with one workflow reference titles it @<title>, else @<name>; anything else gets none', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-wf-title-'))
    const store = createWorkflowStore(root)
    store.save({ projectPath: root, name: 'daily-standup', title: 'Daily standup', prompt: 'Summarise yesterday' })
    store.save({ projectPath: root, name: 'review', prompt: 'Review changes' })
    expect(workflowTitle('@workflow:daily-standup', root, store)).toBe('@Daily standup')
    expect(workflowTitle('  @workflow:review for the login page', root, store)).toBe('@review')
    expect(workflowTitle('@workflow:review then @workflow:review again', root, store)).toBe('@review')
    expect(workflowTitle('@workflow:review and @workflow:daily-standup', root, store)).toBeUndefined()
    expect(workflowTitle('Please run @workflow:review', root, store)).toBeUndefined()
    expect(workflowTitle('@workflow:unknown', root, store)).toBeUndefined()
  })

  it('manual and scheduled runs use the same title, captured at creation; renaming later leaves it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-wf-run-'))
    const store = createWorkflowStore(root)
    const threads = createThreadStore(root)
    const manager = createThreadManager(threads, { launchers: { claude: launcher, codex: launcher } })
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const runner = createWorkflowRunner(store, manager, threads, () => clock)
    closers.push(async () => { runner.close(); await manager.shutdown() })
    const w = store.save({ projectPath: root, name: 'nightly', title: 'Nightly check', prompt: 'Check the build', intervalMinutes: 5 })
    const manual = runner.run(w.id)
    expect(manual.title).toBe('@Nightly check')
    emits.at(-1)!({ kind: 'result', ok: true })
    store.save({ projectPath: root, name: 'nightly', title: 'Renamed', prompt: 'Check the build', intervalMinutes: 5 }, w.id)
    expect(threads.get(manual.id)?.title).toBe('@Nightly check')
    runner.setEnabled(w.id, true)
    clock += 6 * 60_000
    runner.tick()
    const scheduled = threads.list().find((t) => t.workflowTrigger === 'scheduled')
    expect(scheduled?.title).toBe('@Renamed')
  })

  it('a new conversation from the card is titled; an explicit title wins; several references get the first words', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-wf-http-'))
    const server = await startServer({ port: 0, stateRoot: root, webDist: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const post = async (path: string, body: unknown) => (await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
    await post('/api/projects', { path: root })
    await post('/api/workflows', { projectPath: root, name: 'review', title: 'Code review', prompt: 'Review changes' })
    await post('/api/workflows', { projectPath: root, name: 'ship', prompt: 'Ship it' })
    const card = await post('/api/threads', { projectPath: root, text: '@workflow:review the login page', settings: {} })
    expect(card.data.title).toBe('@Code review')
    const explicit = await post('/api/threads', { projectPath: root, text: '@workflow:review', title: 'My own title', settings: {} })
    expect(explicit.data.title).toBe('My own title')
    const several = await post('/api/threads', { projectPath: root, text: '@workflow:review and @workflow:ship', settings: {} })
    expect(several.data.title).toBe('@workflow:review and @workflow:ship')
  })
})
