import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { snapshotHookSources } from '../server/agents/claude/hook-sources.ts'
import { createThreadManager, type LaunchRequest } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-hook-sources-'))
  const home = join(root, 'home'), profileDir = join(home, '.claude'), cwd = join(root, 'project')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(cwd)
  const script = join(root, 'guard.sh')
  writeFileSync(script, '#!/bin/sh\nexit 0\n'); chmodSync(script, 0o755)
  const settings = join(profileDir, 'settings.json')
  const input = { home, cwd, profileDir, pathEnv: '/usr/bin:/bin', accountId: 'account-one', accountGeneration: 1 }
  return { root, home, profileDir, cwd, script, settings, input }
}

it('binds a literal hook executable, args, project, account, and changed script bytes', () => {
  const f = fixture()
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `${f.script} --check`, timeout: 5 }] }] } }))
  const first = snapshotHookSources(f.input)
  expect(first.review).toMatchObject([{ event: 'PreToolUse', source: realpathSync(f.settings), executable: realpathSync(f.script) }])
  expect(first.settings.hooks.PreToolUse).toHaveLength(1)
  expect((first.settings.hooks.PreToolUse?.[0] as { hooks: { command: string }[] }).hooks[0]?.command)
    .toBe(`'${realpathSync(f.script)}' '--check'`)
  expect(snapshotHookSources(f.input).revision).toBe(first.revision)
  expect(snapshotHookSources({ ...f.input, accountGeneration: 2 }).revision).not.toBe(first.revision)
  writeFileSync(f.script, '#!/bin/sh\nexit 1\n')
  expect(snapshotHookSources(f.input).revision).not.toBe(first.revision)
})

it('expands only a literal unquoted home script under a pinned interpreter', () => {
  const f = fixture()
  const script = join(f.home, 'guard.sh')
  writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n'); chmodSync(script, 0o755)
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash ~/guard.sh' }] }] } }))
  const first = snapshotHookSources(f.input)
  expect(first.review[0]?.referencedFiles).toMatchObject([{ path: realpathSync(script) }])
  expect((first.settings.hooks.PreToolUse?.[0] as { hooks: { command: string }[] }).hooks[0]?.command)
    .toBe(`'${realpathSync('/bin/bash')}' '${realpathSync(script)}'`)
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash "~/guard.sh"' }] }] } }))
  expect(() => snapshotHookSources(f.input)).toThrow(/quoted home shortcut/)
})

it('omits an uninstalled enabled plugin visibly while still blocking dynamic hook commands', () => {
  const f = fixture()
  writeFileSync(f.settings, JSON.stringify({ enabledPlugins: { 'unknown@builtin': true } }))
  const unavailable = snapshotHookSources(f.input)
  expect(unavailable.review).toEqual([])
  expect(unavailable.settings.hooks).toEqual({})
  expect(unavailable.unavailable).toMatchObject([{ id: 'unknown@builtin', reason: expect.stringMatching(/omitted/) }])
  expect(snapshotHookSources(f.input).revision).toBe(unavailable.revision)
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `${f.script}; echo bypass` }] }] } }))
  expect(() => snapshotHookSources(f.input)).toThrow(/dynamic shell syntax/)
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `${f.script} [ab]` }] }] } }))
  expect(() => snapshotHookSources(f.input)).toThrow(/dynamic shell syntax/)
})

it('rejects plugin hook files that resolve outside the installed plugin folder', () => {
  const f = fixture()
  const plugin = join(f.root, 'plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  symlinkSync(f.root, join(plugin, 'hooks'))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', hooks: 'hooks/outside.json' }))
  writeFileSync(join(f.root, 'outside.json'), JSON.stringify({ hooks: {} }))
  mkdirSync(join(f.profileDir, 'plugins'))
  writeFileSync(join(f.profileDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fixture@local': [{ installPath: plugin }] } }))
  writeFileSync(f.settings, JSON.stringify({ enabledPlugins: { 'fixture@local': true } }))
  expect(() => snapshotHookSources(f.input)).toThrow(/leaves its installed folder/)
})

it('includes an installed plugin hook file and rejects a changed plugin script', () => {
  const f = fixture()
  const plugin = join(f.root, 'plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  mkdirSync(join(plugin, 'hooks'))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture' }))
  const pluginScript = join(plugin, 'hooks', 'gate.sh')
  writeFileSync(pluginScript, '#!/bin/sh\nexit 0\n'); chmodSync(pluginScript, 0o755)
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/gate.sh' }] }] } }))
  mkdirSync(join(f.profileDir, 'plugins'))
  writeFileSync(join(f.profileDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'fixture@local': [{ installPath: plugin }] } }))
  writeFileSync(f.settings, JSON.stringify({ enabledPlugins: { 'fixture@local': true } }))
  const first = snapshotHookSources(f.input)
  expect(first.review).toMatchObject([{ event: 'SessionStart', executable: realpathSync(pluginScript) }])
  writeFileSync(pluginScript, '#!/bin/sh\nexit 1\n')
  expect(snapshotHookSources(f.input).revision).not.toBe(first.revision)
})

it('passes only approved hook settings and rechecks the script immediately before provider spawn', async () => {
  const f = fixture()
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: f.script }] }] } }))
  const revision = snapshotHookSources(f.input).revision
  const store = createThreadStore(join(f.root, 'state'))
  const launches: LaunchRequest[] = []
  const manager = createThreadManager(store, {
    accounts: { resolve: () => ({ accountId: 'account-one', generation: 1, label: 'Fixture', env: { CLAUDE_CONFIG_DIR: f.profileDir } }), describe: () => undefined },
    projectTrust: () => ({ codexNetwork: false, claudeHooks: true, claudeMcp: false, claudeHooksApproval: revision }),
    launchers: { claude: (req) => { launches.push(req); return { agent: 'claude', alive: () => true, send: () => undefined,
      interrupt: () => undefined, respondApproval: () => undefined, close: async () => undefined } } },
  })
  manager.create({ projectPath: f.cwd, settings: threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'inherit', mcpSetup: 'off' }), text: 'hello' })
  expect(launches).toHaveLength(1)
  expect((launches[0]?.hookSettings?.hooks as Record<string, unknown[]>).PreToolUse).toHaveLength(1)
  expect(() => launches[0]?.validateSources?.()).not.toThrow()
  writeFileSync(f.script, '#!/bin/sh\nexit 2\n')
  expect(() => launches[0]?.validateSources?.()).toThrow(/hook sources changed/)
  await manager.shutdown()
})
