import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecovery, startupHint } from '../server/onboarding/recovery.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { createThreadManager, type LaunchRequest } from '../server/threads/manager.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { CLAUDE_SESSION, writeImportHome } from '../scripts/lib/import-fixtures.ts'
import { claudeProjectDir } from '../server/import/sessions.ts'
import { startServer, type RunningServer } from '../server/start.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'cockpit-recovery-test-'))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); vi.unstubAllEnvs() })
function setup() {
  const root = temp(), project = temp(), importHome = temp()
  writeImportHome(importHome, project)
  const store = createThreadStore(root)
  const launches: LaunchRequest[] = [], messages: string[] = []
  let finish = true
  const manager = createThreadManager(store, { launchers: Object.fromEntries(['claude', 'codex'].map((agent) => [agent, (req: LaunchRequest, sink: (event: unknown) => void) => {
    launches.push(req)
    return { agent, alive: () => true, send: (text: string) => { messages.push(text); if (finish) sink({ kind: 'result', ok: true }) }, close: async () => {}, interrupt() {}, respondApproval() {} }
  }])) })
  cleanups.push(() => manager.shutdown())
  const recovery = createRecovery({ store, manager, importHome, agents: async () => ['claude', 'codex'].map((id) => ({ id: id as 'claude' | 'codex', installation: { installed: true, version: 'fixture' } })) })
  const add = (path = project, settings = threadSettingsSchema.parse({ agent: 'claude' })) => {
    const stamp = new Date().toISOString()
    return store.create({ id: randomUUID(), projectPath: path, settings, sessionId: randomUUID(), sessionStarted: true, title: 'Recent task', createdAt: stamp, updatedAt: stamp, completed: false })
  }
  return { project, importHome, store, manager, launches, messages, recovery, add, stayBusy: () => { finish = false } }
}

describe('recent-work recovery', () => {
  it('finds project sessions, latest user task, and current Git state without starting anything', async () => {
    const s = setup()
    execFileSync('git', ['init', '-b', 'feature/recovery', s.project])
    writeFileSync(join(s.project, 'README.md'), 'Dirty project')
    const view = await s.recovery.discover(s.project)
    expect(view.choices).toHaveLength(2)
    expect(view.choices.find((c) => c.agent === 'claude')?.task).toBe('Now make it follow the system setting')
    expect(view.git).toMatchObject({ branch: 'feature/recovery', changeCount: 1, changes: ['README.md'] })
    expect(s.launches).toHaveLength(0)
    expect(s.store.list()).toHaveLength(0)
  })
  it('imports read-only, resumes the native session, and suppresses repeated dispatch', async () => {
    const s = setup()
    const file = join(claudeProjectDir(s.importHome, s.project), `${CLAUDE_SESSION}.jsonl`)
    const before = readFileSync(file)
    const view = await s.recovery.discover(s.project)
    const body = { projectPath: s.project, offerId: view.offerId, key: `claude:${CLAUDE_SESSION}`, agent: 'claude' as const }
    const meta = await s.recovery.resume(body)
    expect(s.launches[0]).toMatchObject({ resume: CLAUDE_SESSION, settings: { agent: 'claude', permissionMode: 'manual', useHooks: false } })
    expect(s.messages[0]).toContain('inspect_preview')
    expect(s.store.events(meta.id).some((e) => e.event.kind === 'assistant_text')).toBe(true)
    expect((await s.recovery.resume(body)).id).toBe(meta.id)
    expect(s.launches).toHaveLength(1)
    expect(s.messages).toHaveLength(1)
    expect(readFileSync(file)).toEqual(before)
    const again = await s.recovery.discover(s.project)
    expect(again.choices.filter((c) => c.sessionId === CLAUDE_SESSION)).toHaveLength(1)
  })
  it('retains native context while resetting an existing permissive live session to safe defaults', async () => {
    const s = setup()
    const meta = s.add(s.project, threadSettingsSchema.parse({ agent: 'claude', permissionMode: 'auto', useHooks: true, model: 'other-model' }))
    s.manager.send(meta.id, 'old turn')
    const view = await s.recovery.discover(s.project)
    await s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `thread:${meta.id}`, agent: 'claude' })
    expect(s.launches).toHaveLength(2)
    expect(s.launches[1]?.resume).toBe(meta.sessionId)
    expect(s.launches[1]?.settings).toEqual({ agent: 'claude', permissionMode: 'manual', useHooks: false })
  })
  it('hands the transcript to another installed agent without resuming a foreign native session', async () => {
    const s = setup(), view = await s.recovery.discover(s.project)
    const meta = await s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `claude:${CLAUDE_SESSION}`, agent: 'codex' })
    expect(meta.settings.agent).toBe('codex')
    expect(s.launches[0]?.resume).toBeUndefined()
    expect(s.launches[0]?.seed).toContain('follow the system')
  })
  it('refuses busy and foreign threads and reused invalid offers', async () => {
    const s = setup(), meta = s.add(), foreign = s.add(temp())
    const view = await s.recovery.discover(s.project)
    expect(view.choices.some((c) => c.threadId === foreign.id)).toBe(false)
    await expect(s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `thread:${foreign.id}`, agent: 'claude' })).rejects.toThrow('changed or expired')
    s.stayBusy(); s.manager.send(meta.id, 'working now')
    await expect(s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `thread:${meta.id}`, agent: 'claude' })).rejects.toThrow('already working')
    expect(s.messages).toHaveLength(1)
    await expect(s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `thread:${meta.id}`, agent: 'claude' })).rejects.toThrow('already attempted')
  })
  it('does not resurrect completed Cockpit conversations through their import source', async () => {
    const s = setup(), view = await s.recovery.discover(s.project)
    const meta = await s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `claude:${CLAUDE_SESSION}`, agent: 'claude' })
    s.manager.setCompleted(meta.id, true)
    expect((await s.recovery.discover(s.project)).choices.some((c) => c.sessionId === CLAUDE_SESSION)).toBe(false)
  })
  it('rejects a removed source, unavailable agents and expired offers without a launch', async () => {
    const s = setup(), view = await s.recovery.discover(s.project)
    writeFileSync(join(claudeProjectDir(s.importHome, s.project), `${CLAUDE_SESSION}.jsonl`), '')
    await expect(s.recovery.resume({ projectPath: s.project, offerId: view.offerId, key: `claude:${CLAUDE_SESSION}`, agent: 'claude' })).rejects.toThrow('no longer available')
    const next = await s.recovery.discover(s.project)
    await expect(s.recovery.resume({ projectPath: s.project, offerId: next.offerId, key: next.choices[0]!.key, agent: 'opencode' })).rejects.toThrow('unavailable')
    const expired = await s.recovery.discover(s.project)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
    await expect(s.recovery.resume({ projectPath: s.project, offerId: expired.offerId, key: expired.choices[0]!.key, agent: 'claude' })).rejects.toThrow('expired')
    clock.mockRestore()
    expect(s.launches).toHaveLength(0)
  })
  it('treats a manifest as a hint and handles missing or malformed manifests honestly', () => {
    const project = temp()
    expect(startupHint(project)).toBeUndefined()
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    expect(startupHint(project)).toBe('npm run dev')
    writeFileSync(join(project, 'pnpm-lock.yaml'), '')
    expect(startupHint(project)).toBe('pnpm run dev')
    writeFileSync(join(project, 'package.json'), '{')
    expect(startupHint(project)).toBeUndefined()
  })
})

it('HTTP recovery requires an opened local project, validates input and respects the origin guard', async () => {
  const root = temp(), project = temp()
  vi.stubEnv('COCKPIT_IMPORT_HOME', temp())
  const server: RunningServer = await startServer({ port: 0, stateRoot: root, webDist: root, agentProbe: async () => ({ installed: false, problem: 'fixture' }) })
  cleanups.push(() => server.close())
  const url = `${server.url}/api/recovery?${new URLSearchParams({ projectPath: project })}`
  expect((await fetch(url)).status).toBe(404)
  server.projects.open(project)
  expect((await (await fetch(url)).json()).data.choices).toEqual([])
  expect((await fetch(url, { headers: { origin: 'https://foreign.test' } })).status).toBe(403)
  expect((await fetch(`${server.url}/api/recovery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
  expect(server.store.list()).toHaveLength(0)
})
