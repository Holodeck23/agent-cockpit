import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink } from '../server/agents/types.ts'
import { startServer } from '../server/start.ts'
import { buildHandoff, HANDOFF_BUDGET, previewHandoff } from '../server/threads/handoff.ts'
import { createThreadManager, HandoffChangedError, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema, type StoredEvent } from '../server/threads/types.ts'

const user = (text: string): StoredEvent => ({ ts: '', event: { kind: 'user_text', text } })
const reply = (text: string): StoredEvent => ({ ts: '', event: { kind: 'assistant_text', messageId: 'm', text } })
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A launcher whose sessions record what they were started with; `emit` drives the newest one. */
function recordingLauncher(): { launcher: Launcher; requests: LaunchRequest[]; emit: EventSink } {
  const requests: LaunchRequest[] = []
  const state = { emit: (() => undefined) as EventSink }
  const launcher: Launcher = (request, onEvent) => {
    requests.push(request)
    state.emit = onEvent
    let alive = true
    const session: AgentSession = {
      agent: request.settings.agent, send() {}, respondApproval() {}, interrupt() {},
      close: async () => { alive = false; onEvent({ kind: 'exit', code: 0 }) },
      alive: () => alive,
    }
    return session
  }
  return { launcher, requests, emit: (event) => state.emit(event) }
}

describe('handoff preview (D13)', () => {
  it('is the exact text a switch sends, with its sha256', () => {
    const events = [user('TASK: port the parser'), reply('Started on lexer.rs')]
    const preview = previewHandoff(events, '/project')
    expect(preview.text).toBe(buildHandoff(events, '/project'))
    expect(preview.digest).toBe(sha256(preview.text))
    expect(preview.leftOut).toBe(0)
    expect(preview.budget).toBe(HANDOFF_BUDGET)
  })

  it('says how many messages were left out to fit, matching the note in the text', () => {
    const events = [user('TASK'), ...Array.from({ length: 200 }, (_, i) => [user(`q${i}`), reply(`a${i} ${'x'.repeat(5_000)}`)]).flat()]
    const preview = previewHandoff(events, '/project')
    expect(preview.leftOut).toBeGreaterThan(0)
    expect(preview.text).toContain(`[${preview.leftOut} earlier messages left out to fit]`)
  })
})

describe('switching with a reviewed handoff (D13)', () => {
  function setup() {
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-handoff-')))
    const { launcher, requests, emit } = recordingLauncher()
    const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
    const settings = threadSettingsSchema.parse({})
    return { store, manager, requests, emit, settings }
  }

  it('the new agent receives exactly the text that was shown', () => {
    const { manager, requests, emit, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'port the parser' })
    emit({ kind: 'assistant_text', messageId: 'm1', text: 'Lexer done' })
    emit({ kind: 'result', ok: true })
    const shown = manager.handoffPreview(meta.id)
    manager.switchAgent(meta.id, { ...settings, agent: 'codex' }, shown.digest)
    manager.send(meta.id, 'carry on')
    expect(requests.at(-1)?.settings.agent).toBe('codex')
    expect(requests.at(-1)?.seed).toBe(shown.text)
  })

  it('refuses when the conversation changed after the preview, and changes nothing', () => {
    const { store, manager, emit, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'port the parser' })
    emit({ kind: 'result', ok: true })
    const shown = manager.handoffPreview(meta.id)
    emit({ kind: 'assistant_text', messageId: 'm2', text: 'A late note' })
    const before = store.events(meta.id).length
    expect(() => manager.switchAgent(meta.id, { ...settings, agent: 'codex' }, shown.digest)).toThrow(HandoffChangedError)
    expect(store.get(meta.id)?.settings.agent).toBe('claude')
    expect(store.get(meta.id)?.handoff).toBeUndefined()
    expect(store.events(meta.id)).toHaveLength(before)
    // Reviewing again shows the late note, and that preview switches.
    const again = manager.handoffPreview(meta.id)
    expect(again.text).toContain('A late note')
    expect(() => manager.switchAgent(meta.id, { ...settings, agent: 'codex' }, again.digest)).not.toThrow()
  })
})

describe('GET /handoff and POST /agent (D13)', () => {
  it('previews, refuses a switch without or with a stale digest, and sends the shown text', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-handoff-state-'))
    const project = mkdtempSync(join(tmpdir(), 'cockpit-handoff-project-'))
    const { launcher, requests, emit } = recordingLauncher()
    const server = await startServer({ port: 0, stateRoot, webDist: project, launchers: { claude: launcher, codex: launcher } })
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const created = await (await post('/api/threads', { projectPath: project, text: 'port the parser', settings: { agent: 'claude' } })).json()
      const id = created.data.id as string
      emit({ kind: 'result', ok: true })
      const preview = (await (await fetch(`${server.url}/api/threads/${id}/handoff`)).json()).data as { text: string; digest: string }
      expect(preview.text).toContain('USER: port the parser')
      expect(preview.digest).toBe(sha256(preview.text))
      const codex = { agent: 'codex', permissionMode: 'manual', useHooks: false }
      expect((await post(`/api/threads/${id}/agent`, { settings: codex })).status).toBe(400)
      expect((await post(`/api/threads/${id}/agent`, { settings: codex, handoff: sha256('something else') })).status).toBe(409)
      expect((await post(`/api/threads/${id}/agent`, { settings: codex, handoff: preview.digest })).status).toBe(200)
      expect((await post(`/api/threads/${id}/messages`, { text: 'carry on' })).ok).toBe(true)
      expect(requests.at(-1)?.seed).toBe(preview.text)
    } finally { await server.close() }
  })
})
