import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentSession } from '../server/agents/types.ts'
import { codexMcpConfigArgs } from '../server/mcp/wiring.ts'
import { createProjectStore, projectPatchSchema } from '../server/projects/store.ts'
import { codexConfigArgs, createThreadManager, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

it('persists explicit trust and revocation in Cockpit state without changing other projects', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-network-'))
  const projects = createProjectStore(root)
  projects.open('/work/a', { codexNetwork: true })
  projects.open('/work/b')
  expect(createProjectStore(root).list().find((p) => p.path === '/work/a')?.codexNetwork).toBe(true)
  projects.open('/work/a', { codexNetwork: false })
  expect(createProjectStore(root).list().find((p) => p.path === '/work/a')?.codexNetwork).toBe(false)
  expect(projects.list().find((p) => p.path === '/work/b')?.codexNetwork).toBeUndefined()
  expect(projectPatchSchema.safeParse({ codexNetwork: 'true' }).success).toBe(false)
  expect(readFileSync(join(root, 'projects.json'), 'utf8')).toContain('"codexNetwork": false')
})

it('stores independent Claude hook and connector preferences with absent meaning on', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-claude-setup-'))
  const projects = createProjectStore(root)
  projects.open('/work/a')
  expect(projects.list()[0]?.claudeHooks).toBeUndefined()
  expect(projects.list()[0]?.claudeMcp).toBeUndefined()
  projects.open('/work/a', { claudeHooks: false, claudeMcp: true })
  expect(createProjectStore(root).list()[0]).toMatchObject({ claudeHooks: false, claudeMcp: true })
  projects.open('/work/a', { claudeHooks: true, claudeMcp: false })
  expect(createProjectStore(root).list()[0]).toMatchObject({ claudeHooks: true, claudeMcp: false })
  expect(projectPatchSchema.safeParse({ claudeHooks: 'true' }).success).toBe(false)
  expect(projectPatchSchema.safeParse({ claudeMcpApproval: 'a'.repeat(64) }).data).toEqual({})
  projects.open('/work/a', { claudeMcp: true })
  projects.approveClaudeHooks('/work/a', 'c'.repeat(64))
  expect(createProjectStore(root).list()[0]?.claudeHooksApproval).toBe('c'.repeat(64))
  const worktreeId = randomUUID()
  projects.approveClaudeHooks('/work/a', 'd'.repeat(64), worktreeId)
  expect(createProjectStore(root).list()[0]?.claudeHooksApprovals?.[worktreeId]).toBe('d'.repeat(64))
  expect(createProjectStore(root).list()[0]?.claudeHooksApproval).toBe('c'.repeat(64))
  projects.approveClaudeMcp('/work/a', 'a'.repeat(64))
  expect(createProjectStore(root).list()[0]?.claudeMcpApproval).toBe('a'.repeat(64))
  projects.approveClaudeMcp('/work/a', 'e'.repeat(64), worktreeId)
  expect(createProjectStore(root).list()[0]?.claudeMcpApprovals?.[worktreeId]).toBe('e'.repeat(64))
  projects.open('/work/a', { claudeMcp: false })
  expect(createProjectStore(root).list()[0]?.claudeMcpApproval).toBeUndefined()
  expect(createProjectStore(root).list()[0]?.claudeMcpApprovals).toBeUndefined()
  projects.open('/work/a', { claudeHooks: false })
  expect(createProjectStore(root).list()[0]?.claudeHooksApproval).toBeUndefined()
  expect(createProjectStore(root).list()[0]?.claudeHooksApprovals).toBeUndefined()
  // An explicit conversation override can be reviewed while the project default remains off.
  projects.approveClaudeMcp('/work/a', 'b'.repeat(64))
  projects.open('/work/a', { name: 'Renamed', claudeMcp: false })
  expect(createProjectStore(root).list()[0]?.claudeMcpApproval).toBe('b'.repeat(64))
})

it('explicitly overrides both permissive and restrictive CLI defaults without losing MCP wiring', () => {
  const cockpit = { command: 'node', args: ['mcp.cjs'], env: {}, secretEnv: {} }
  for (const codexNetwork of [true, false]) {
    expect(codexConfigArgs({ cockpit, codexNetwork })).toEqual([
      ...codexMcpConfigArgs(cockpit), '-c', `sandbox_workspace_write.network_access=${codexNetwork}`,
    ])
  }
  expect(codexConfigArgs({})).toEqual([])
})

it('isolates project trust, keeps a running session unchanged, and reads revocation when resuming', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-network-'))
  const projects = createProjectStore(root)
  projects.open('/work/a', { codexNetwork: true })
  projects.open('/work/b')
  const requests: LaunchRequest[] = []
  const launcher: Launcher = (req, emit) => {
    requests.push(req)
    let alive = true
    const session: AgentSession = {
      agent: req.settings.agent,
      send: () => emit({ kind: 'session', sessionId: req.resume ?? req.sessionId! }),
      respondApproval: () => undefined, interrupt: () => undefined,
      close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) },
      alive: () => alive,
    }
    return session
  }
  const manager = createThreadManager(createThreadStore(root), {
    launchers: { codex: launcher, claude: launcher },
    projectTrust: (path) => ({ codexNetwork: projects.list().find((p) => p.path === path)?.codexNetwork === true }),
  })
  try {
    const settings = threadSettingsSchema.parse({ agent: 'codex' })
    const a = manager.create({ projectPath: '/work/a', settings, text: 'first' })
    manager.create({ projectPath: '/work/b', settings, text: 'other' })
    manager.create({ projectPath: '/work/a', settings: threadSettingsSchema.parse({ agent: 'claude' }), text: 'claude' })
    expect(requests.map((r) => r.codexNetwork)).toEqual([true, false, undefined])
    await new Promise<void>((done) => queueMicrotask(done))
    projects.open('/work/a', { codexNetwork: false })
    manager.send(a.id, 'queued on the current session')
    expect(requests).toHaveLength(3)
    await manager.shutdown()
    manager.send(a.id, 'after restart')
    expect(requests.at(-1)).toMatchObject({ codexNetwork: false, resume: a.sessionId })
  } finally { await manager.shutdown() }
})
