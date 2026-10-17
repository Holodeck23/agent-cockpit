import { expect, it } from 'vitest'
import { parseBuiltinPluginDetails } from '../server/agents/claude/builtin-plugins.ts'
import { snapshotHookSources } from '../server/agents/claude/hook-sources.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// W13 U3b: a `@builtin` plugin has no installed folder; it ships inside the Claude CLI. It passes the hook
// review only when that CLI says it carries no hooks, or does not ship it. Anything else stays blocked.
const ID = 'cc-plugin-you-should-know@builtin'
// Recorded from `claude plugin details` (2.1.302 on a profile that has it; 2.1.220, which does not ship it).
const PRESENT = `cc-plugin-you-should-know
  Description: You should know: a side agent watches your back while Claude works on longer tasks.
  Source: ${ID}

Component inventory
  Skills (0)
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)
`
const ABSENT = `Plugin "${ID}" not found. Run \`claude plugin list\` to see installed plugins, or pass --plugin-dir <path> to load one from disk.\n`

it('reads the hook count, absence, and nothing else from the CLI text', () => {
  expect(parseBuiltinPluginDetails(ID, PRESENT)).toEqual({ state: 'present', hooks: 0 })
  expect(parseBuiltinPluginDetails(ID, PRESENT.replace('Hooks (0)', 'Hooks (2)'))).toEqual({ state: 'present', hooks: 2 })
  expect(parseBuiltinPluginDetails(ID, ABSENT)).toEqual({ state: 'absent' })
  // Another plugin's "not found", a changed format, or no inventory: unknown.
  expect(parseBuiltinPluginDetails(ID, ABSENT.replace(ID, 'other@builtin')).state).toBe('unknown')
  expect(parseBuiltinPluginDetails(ID, PRESENT.replace('Hooks (0)', 'Hooks: none')).state).toBe('unknown')
  expect(parseBuiltinPluginDetails(ID, '').state).toBe('unknown')
})

function profileWith(enabled: Record<string, boolean>) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-builtin-'))
  const home = join(root, 'home'), profileDir = join(home, '.claude'), cwd = join(root, 'project')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(cwd)
  writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }))
  return { home, cwd, profileDir, pathEnv: '/usr/bin:/bin' }
}

it('passes a built-in plugin the CLI ships with no hooks, or does not ship', () => {
  const input = profileWith({ [ID]: true })
  expect(snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'present', hooks: 0 }) }).unavailable).toEqual([])
  expect(snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'absent' }) }).unavailable).toEqual([])
})

it('keeps a built-in plugin with hooks, or one the CLI cannot describe, blocked', () => {
  const input = profileWith({ [ID]: true })
  expect(snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'present', hooks: 1 }) }).unavailable)
    .toMatchObject([{ id: ID, reason: 'Built-in plugin has 1 hook Cockpit cannot pass through; it is omitted' }])
  expect(snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'unknown', reason: 'Claude did not describe this built-in plugin' }) }).unavailable)
    .toMatchObject([{ id: ID, reason: 'Claude did not describe this built-in plugin; it is omitted' }])
  // With no Claude on PATH there is nothing to ask: blocked.
  expect(snapshotHookSources(input).unavailable).toMatchObject([{ id: ID, reason: expect.stringMatching(/not installed.*omitted/) }])
})

it('changes the revision when the CLI answer changes, and never asks about a plugin that is off', () => {
  const input = profileWith({ [ID]: true })
  const none = snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'present', hooks: 0 }) }).revision
  expect(snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'absent' }) }).revision).not.toBe(none)
  let asked = false
  snapshotHookSources({ ...profileWith({ [ID]: false }), builtinPlugin: () => { asked = true; return { state: 'absent' } } })
  expect(asked).toBe(false)
})

it('a plugin that is not built in still needs an installed source', () => {
  const input = profileWith({ 'missing@market': true })
  expect(snapshotHookSources({ ...input, builtinPlugin: () => ({ state: 'absent' }) }).unavailable)
    .toMatchObject([{ id: 'missing@market', reason: 'Enabled plugin has no installed source; it is omitted' }])
})
