import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { snapshotMcpSources } from '../server/agents/claude/mcp-sources.ts'
import { createWorkspaceStore } from '../server/projects/workspaces.ts'
import { createThreadManager, type LaunchRequest } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

it('binds approved MCP source, executable and script revisions without exposing environment values', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-mcp-sources-'))
  const home = join(root, 'home'), cwd = join(root, 'project')
  mkdirSync(home); mkdirSync(cwd)
  const executable = join(root, 'runner')
  const script = join(root, 'server.js')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o755)
  writeFileSync(script, 'process.stdout.write("ready")')
  const file = join(cwd, '.mcp.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { external: { type: 'stdio', command: executable, args: [script], env: { KEY: 'synthetic-secret' } } } }))
  const input = { home, cwd, pathEnv: '/usr/bin:/bin' }
  const first = snapshotMcpSources(input)
  expect(first.review).toMatchObject([{ name: 'external', source: file, executable: realpathSync(executable) }])
  expect(first.servers.external?.command).toBe(realpathSync(executable))
  expect(JSON.stringify(first.review)).not.toContain('synthetic-secret')
  expect(snapshotMcpSources({ ...input, accountId: 'other-account' }).revision).not.toBe(first.revision)
  expect(snapshotMcpSources({ ...input, accountGeneration: 2 }).revision).not.toBe(first.revision)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 1 }))
  expect(snapshotMcpSources(input).revision).toBe(first.revision)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 2 }))
  expect(snapshotMcpSources(input).revision).toBe(first.revision)
  writeFileSync(script, 'process.stdout.write("changed")')
  expect(snapshotMcpSources(input).revision).not.toBe(first.revision)
  writeFileSync(file, JSON.stringify({ mcpServers: { cockpit: { type: 'stdio', command: executable, args: [] } } }))
  expect(() => snapshotMcpSources(input)).toThrow(/Reserved/)
})

it('imports installed plugin MCP definitions and visibly omits an uninstalled plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-plugin-mcp-'))
  const home = join(root, 'home'), profile = join(home, '.claude'), cwd = join(root, 'project'), plugin = join(root, 'plugin')
  mkdirSync(join(profile, 'plugins'), { recursive: true }); mkdirSync(cwd)
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  const manifest = join(plugin, '.claude-plugin', 'plugin.json')
  writeFileSync(manifest, JSON.stringify({ name: 'fixture', mcpServers: { fixture: { type: 'http', url: 'https://example.test/mcp' } } }))
  writeFileSync(join(profile, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fixture@local': [{ installPath: plugin }] } }))
  const settings = join(profile, 'settings.json')
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'fixture@local': true } }))
  const input = { home, profileDir: profile, cwd, pathEnv: '/usr/bin:/bin' }
  const first = snapshotMcpSources(input)
  expect(first.review).toMatchObject([{ name: 'fixture', source: join(realpathSync(plugin), '.claude-plugin', 'plugin.json'), url: 'https://example.test/mcp' }])
  expect(first.servers.fixture?.url).toBe('https://example.test/mcp')
  writeFileSync(manifest, JSON.stringify({ name: 'fixture', mcpServers: { fixture: { type: 'http', url: 'https://example.test/new' } } }))
  expect(snapshotMcpSources(input).revision).not.toBe(first.revision)
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'unknown@builtin': true } }))
  const unavailable = snapshotMcpSources(input)
  expect(unavailable.servers).toEqual({})
  expect(unavailable.unavailable).toMatchObject([{ name: 'unknown@builtin', reason: expect.stringMatching(/omitted/) }])
  expect(unavailable.revision).not.toBe(first.revision)
})

it('omits download-on-launch connector commands and reserves their names', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-plugin-mcp-'))
  const home = join(root, 'home'), cwd = join(root, 'project')
  mkdirSync(home); mkdirSync(cwd)
  const file = join(cwd, '.mcp.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { dynamic: { command: 'npx', args: ['@playwright/mcp@latest'] },
    verified: { type: 'http', url: 'https://example.test/mcp' } } }))
  const snapshot = snapshotMcpSources({ home, cwd, pathEnv: '' })
  expect(Object.keys(snapshot.servers)).toEqual(['verified'])
  expect(snapshot.unavailable).toMatchObject([{ name: 'dynamic', reason: expect.stringMatching(/Pin a local executable/) }])
})

it('pins plugin-relative executable scripts and blocks a plugin MCP file escaping by symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-plugin-mcp-'))
  const home = join(root, 'home'), profile = join(home, '.claude'), cwd = join(root, 'project'), plugin = join(root, 'plugin')
  mkdirSync(join(profile, 'plugins'), { recursive: true }); mkdirSync(cwd)
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  const script = join(plugin, 'server.js')
  writeFileSync(script, 'process.stdout.write("ready")')
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['./server.js'] } } }))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture' }))
  writeFileSync(join(profile, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fixture@local': [{ installPath: plugin }] } }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fixture@local': true } }))
  const input = { home, profileDir: profile, cwd, pathEnv: process.env.PATH ?? '' }
  const first = snapshotMcpSources(input)
  expect(first.servers.fixture?.args).toEqual([realpathSync(script)])
  writeFileSync(script, 'process.stdout.write("changed")')
  expect(snapshotMcpSources(input).revision).not.toBe(first.revision)
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['-e', 'process.exit(0)'] } } }))
  expect(() => snapshotMcpSources(input)).toThrow(/pinned script/)
  const external = join(root, 'external.json')
  writeFileSync(external, JSON.stringify({ mcpServers: {} }))
  symlinkSync(external, join(plugin, 'linked.json'))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', mcpServers: 'linked.json' }))
  expect(() => snapshotMcpSources(input)).toThrow(/leaves its installed folder/)
})

it('does not apply a main-checkout approval to a worktree launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-worktree-approval-'))
  const project = join(root, 'project'), worktree = join(root, 'worktree'), profile = join(root, 'profile')
  mkdirSync(project); mkdirSync(worktree); mkdirSync(profile)
  writeFileSync(join(worktree, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.test/mcp' } } }))
  const workspaceStore = createWorkspaceStore(join(root, 'state'))
  mkdirSync(join(root, 'state'))
  workspaceStore.ensure([project])
  const primary = workspaceStore.primaryFor(project)!
  const secondary = workspaceStore.addWorktree({ projectId: primary.project.id, cwd: worktree, name: 'fixture', branch: 'fixture',
    baseRef: 'main', baseCommit: 'a'.repeat(40), createdFrom: primary.workspace.id })
  const revision = snapshotMcpSources({ home: homedir(), profileDir: profile, cwd: worktree, pathEnv: process.env.PATH ?? '',
    accountId: 'account-one', accountGeneration: 1 }).revision
  let worktreeApproval: string | undefined
  const launches: LaunchRequest[] = []
  const manager = createThreadManager(createThreadStore(join(root, 'threads')), {
    workspace: (id) => workspaceStore.get(id), workspaceFor: () => primary.workspace.id,
    accounts: { resolve: () => ({ accountId: 'account-one', generation: 1, label: 'Fixture', env: { CLAUDE_CONFIG_DIR: profile } }), describe: () => undefined },
    projectTrust: (_path, id) => ({ codexNetwork: false, claudeHooks: false, claudeMcp: true,
      claudeMcpApproval: id === secondary.id ? worktreeApproval : revision }),
    launchers: { claude: (request) => { launches.push(request); return { agent: 'claude', alive: () => true, send: () => undefined,
      interrupt: () => undefined, respondApproval: () => undefined, close: async () => undefined } } },
  })
  const settings = threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'off', mcpSetup: 'on' })
  manager.create({ projectPath: project, workspaceId: secondary.id, settings, text: 'blocked' })
  expect(launches).toHaveLength(0)
  worktreeApproval = revision
  manager.create({ projectPath: project, workspaceId: secondary.id, settings, text: 'approved' })
  expect(launches).toHaveLength(1)
  expect(launches[0]?.cwd).toBe(worktree)
  await manager.shutdown()
})
