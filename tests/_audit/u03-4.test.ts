import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_DIR } from '../../server/agents/antigravity/mcp-plugin.ts'
import type { AgentCapabilities } from '../../server/agents/capabilities/types.ts'
import { createAgyMcp } from '../../server/projects/agy-mcp.ts'
import { createProjectStore } from '../../server/projects/store.ts'
import { antigravityLauncher, createThreadManager } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u03-4: connectPlugin (server/agents/antigravity/mcp-plugin.ts) only returns typed failures for the
// cases it expects. mkdirSync (l.133), commit's writeFileSync (l.88), readPlain on a non-ENOENT error
// (l.81) and the backup write (l.151) THROW. In launch mode agy-mcp prepare() calls it synchronously
// from antigravityLauncher, inside ensureSession, after the MCP grant was issued (manager.ts:611) and
// the session_boundary recorded. The throw escapes the launcher: no Live entry exists, releaseGrant is
// never called, and send() fails with a raw fs error instead of starting without Cockpit's tools.
// CORRECT behaviour (manager.ts:151, AntigravityMcpPrepare): prepare() reports { ready: false, reason }
// and the session starts without Cockpit's tools; no grant is left issued.

const OLD = { command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit', args: ['old-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
const NEW = { command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit', args: ['new-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
const root = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0

/** A project that opted in with the OLD command; returns it plus an agyMcp for the NEW (rebuilt) command. */
function optedIn() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-4-state-'))
  const folder = mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-4-project-'))
  const projects = createProjectStore(stateRoot)
  projects.open(folder)
  expect(createAgyMcp(projects, OLD).setConnected(folder, true)).toMatchObject({ ok: true })
  // The app was rebuilt: Cockpit's own unchanged entry must be rewritten at the next launch.
  return { folder, stateRoot, agyMcp: createAgyMcp(projects, NEW) }
}

const attempt = <T,>(fn: () => T): { value?: T; error?: unknown } => {
  try { return { value: fn() } } catch (error) { return { error } }
}

describe('u03-4: a filesystem error while preparing the Antigravity plugin must not escape the launch', () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const dir of cleanup.splice(0)) { try { chmodSync(dir, 0o755) } catch { /* gone */ } }
  })
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it.skipIf(root())('prepare() answers { ready: false, reason } when the plugin folder is read-only (backup/commit write fails)', () => {
    const { folder, agyMcp } = optedIn()
    const pluginDir = join(folder, PLUGIN_DIR)
    cleanup.push(pluginDir)
    chmodSync(pluginDir, 0o555)
    const { value, error } = attempt(() => agyMcp.prepare(folder))
    expect(error).toBeUndefined()
    expect(value).toMatchObject({ ready: false })
    expect(typeof value?.reason).toBe('string')
  })

  it('prepare() answers { ready: false, reason } when the plugin folder cannot be created (mkdirSync fails)', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-4-state-'))
    const folder = mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-4-project-'))
    const projects = createProjectStore(stateRoot)
    projects.open(folder)
    expect(createAgyMcp(projects, OLD).setConnected(folder, true)).toMatchObject({ ok: true })
    // The project folder is later replaced by a plain file (volume swapped, folder recreated as a file):
    // mkdirSync('<file>/.agents/plugins/cockpit', { recursive: true }) throws ENOTDIR.
    rmSync(folder, { recursive: true, force: true })
    writeFileSync(folder, 'not a folder')
    const { value, error } = attempt(() => createAgyMcp(projects, OLD).prepare(folder))
    expect(error).toBeUndefined()
    expect(value).toMatchObject({ ready: false })
    expect(typeof value?.reason).toBe('string')
  })

  describe('through the thread manager', () => {
    // A stand-in agy: no real CLI runs.
    function fakeAgy(): string {
      const dir = mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-4-agy-'))
      const exe = join(dir, 'agy')
      writeFileSync(exe, `#!/bin/sh
while IFS= read -r line; do
  printf '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"ok"}}\\n'
done
`)
      chmodSync(exe, 0o755)
      return exe
    }
    const found = (exe: string): AgentCapabilities => ({ agent: 'antigravity', context: 'default', settings: {}, auth: { state: 'signed_in' }, models: { state: 'not_checked' },
      executable: { state: 'found', identity: { command: 'agy', path: exe, realpath: exe, fingerprint: 'f', version: '1.3.0' } } })

    function harness() {
      const { folder, agyMcp } = optedIn()
      const pluginDir = join(folder, PLUGIN_DIR)
      cleanup.push(pluginDir)
      chmodSync(pluginDir, 0o555)
      const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-audit-u03-4-threads-')))
      let issued = 0
      let released = 0
      const manager = createThreadManager(store, {
        launchers: { antigravity: antigravityLauncher(async () => found(fakeAgy()), (path) => agyMcp.prepare(path)) },
        mcp: () => {
          issued += 1
          let once = false
          return {
            launch: { ...NEW, secretEnv: { COCKPIT_MCP_URL: 'http://127.0.0.1:1', COCKPIT_MCP_TOKEN: `token-${issued}` } },
            release: () => { if (!once) { once = true; released += 1 } },
          }
        },
      })
      const now = new Date().toISOString()
      const meta = store.create({
        id: randomUUID(), title: 'agy', projectPath: folder, settings: threadSettingsSchema.parse({ agent: 'antigravity' }),
        sessionId: randomUUID(), bindingId: randomUUID(), sessionStarted: false, completed: false, createdAt: now, updatedAt: now,
      })
      return { manager, store, meta, counts: () => ({ issued, released }) }
    }

    it.skipIf(root())('send() starts the session without Cockpit tools instead of failing with a raw fs error', async () => {
      const { manager, meta } = harness()
      const { error } = attempt(() => manager.send(meta.id, 'hello'))
      await manager.shutdown()
      expect(error).toBeUndefined()
    })

    it.skipIf(root())('a launch that could not prepare the plugin leaves no MCP grant issued', async () => {
      const { manager, meta, counts } = harness()
      attempt(() => manager.send(meta.id, 'hello'))
      await manager.shutdown()
      const { issued, released } = counts()
      expect(issued).toBeGreaterThan(0)
      expect(released).toBe(issued)
    })

    it.skipIf(root())('a failed launch does not leave a session_boundary behind with no session', async () => {
      const { manager, store, meta } = harness()
      const { error } = attempt(() => manager.send(meta.id, 'hello'))
      await manager.shutdown()
      const boundaries = store.events(meta.id).filter((e) => e.event.kind === 'session_boundary').length
      const userTexts = store.events(meta.id).filter((e) => e.event.kind === 'user_text').length
      // Either the launch worked (boundary + the user's message), or nothing was recorded for it.
      expect(error === undefined ? userTexts : boundaries).toBe(error === undefined ? 1 : 0)
    })
  })

  // Keeps unused-import linting honest for helpers used only on some platforms.
  void existsSync; void mkdirSync; void readFileSync
})
