import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listEnabledPlugins, pluginEntries, readPluginManifest, strippedManifest } from '../server/agents/setup/plugin-projection.ts'
import { PROJECTED_PLUGINS, snapshotSkillSource } from '../server/agents/setup/skill-projection.ts'
import { createSkillProvider, createSkillSelectionStore } from '../server/agents/setup/skill-selection.ts'

// W13 U6: skills, commands and agents of plugins the user enabled reach Claude as a stripped copy under
// the plugin's own name. Its hooks, connectors and scripts never do, and a plugin that changes, moves
// or is turned off asks for a new review.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-plugin-projection-')))
  const profile = join(root, 'default-claude')
  const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  const plugin = (market: string, name: string, version: string, files: Record<string, string>): string => {
    const dir = join(profile, 'plugins', 'cache', market, name, version)
    for (const [path, text] of Object.entries(files)) write(join(dir, path), text)
    return dir
  }
  const tools = plugin('market', 'tools', '1.0.0', {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'tools', version: '1.0.0', description: 'W13 fictional tools', author: { name: 'x' },
      commands: ['./commands/a.md', '../escape.md'], hooks: { PreToolUse: [] }, mcpServers: { db: { command: 'db' } } }),
    'skills/s1/SKILL.md': '---\nname: s1\n---\nW13 fictional plugin skill',
    'commands/a.md': 'declared command', 'commands/b.md': 'undeclared command',
    'hooks/hooks.json': '{"hooks":{}}', '.mcp.json': '{"mcpServers":{}}', 'scripts/run.sh': 'echo never copied',
  })
  const conn = plugin('market', 'conn', '2.0.0', { '.claude-plugin/plugin.json': JSON.stringify({ name: 'conn' }), '.mcp.json': '{}' })
  const outside = join(root, 'elsewhere', 'outside')
  write(join(outside, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'outside' }))
  const installed = (entries: Record<string, string>) => write(join(profile, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2,
    plugins: Object.fromEntries(Object.entries(entries).map(([key, installPath]) => [key, [{ scope: 'user', installPath, version: '1' }]])) }))
  installed({ 'tools@market': tools, 'conn@market': conn, 'outside@market': outside, 'off@market': conn })
  const enable = (enabled: Record<string, boolean>) => write(join(profile, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }))
  enable({ 'tools@market': true, 'conn@market': true, 'outside@market': true, 'missing@market': true, 'off@market': false, 'cli-thing@builtin': true })
  return { root, profile, write, plugin, tools, conn, installed, enable }
}

describe('enabled plugins (W13 U6)', () => {
  it('lists enabled, installed plugins in the plugin cache, and says why any other cannot be included', () => {
    const f = fixture()
    expect(listEnabledPlugins(f.profile)).toEqual([
      { key: 'conn@market', installPath: f.conn, name: 'conn', version: '1' },
      { key: 'missing@market', installPath: '', name: 'missing', problem: 'not installed for you' },
      { key: 'outside@market', installPath: join(f.root, 'elsewhere', 'outside'), name: 'outside', problem: 'installed outside your plugin folder' },
      { key: 'tools@market', installPath: f.tools, name: 'tools', version: '1.0.0' },
    ])
  })

  it('offers neither of two enabled plugins with the same name', () => {
    const f = fixture()
    const twin = f.plugin('other', 'tools', '9.0.0', { '.claude-plugin/plugin.json': JSON.stringify({ name: 'tools' }), 'skills/x/SKILL.md': 'x' })
    f.installed({ 'tools@market': f.tools, 'tools@other': twin })
    f.enable({ 'tools@market': true, 'tools@other': true })
    expect(listEnabledPlugins(f.profile).map((row) => row.problem)).toEqual(['another enabled plugin has the same name', 'another enabled plugin has the same name'])
  })

  it('strips the manifest to identity and listed paths inside the copied folders', () => {
    const f = fixture()
    const { manifest, dropped } = strippedManifest(readPluginManifest(f.tools))
    expect(manifest).toEqual({ name: 'tools', version: '1.0.0', description: 'W13 fictional tools', commands: ['./commands/a.md'] })
    expect(dropped).toEqual(['commands', 'hooks', 'mcpServers'])
    expect(pluginEntries(f.tools, readPluginManifest(f.tools))).toEqual({ skills: 1, commands: 1, agents: 0 })
  })

  it('copies only skills, commands and agents, and stops counting a plugin that moved or was turned off', () => {
    const f = fixture()
    const ref = { key: 'tools@market', installPath: f.tools }
    const plain = snapshotSkillSource(f.profile)
    const snap = snapshotSkillSource(f.profile, { plugins: [ref] })
    expect(snap.plugins).toEqual([{ ...ref, name: 'tools' }])
    expect(snap.files.map((file) => file.relativePath).sort()).toEqual([
      join(PROJECTED_PLUGINS, 'tools', '.claude-plugin', 'plugin.json'), join(PROJECTED_PLUGINS, 'tools', 'commands', 'a.md'),
      join(PROJECTED_PLUGINS, 'tools', 'commands', 'b.md'), join(PROJECTED_PLUGINS, 'tools', 'skills', 's1', 'SKILL.md')])
    // The user's own names are unchanged: plugin entries live under the plugin's namespace.
    expect(snap.skills).toEqual(plain.skills)
    expect(snap.revision).not.toBe(plain.revision)
    const updated = f.plugin('market', 'tools', '1.1.0', { '.claude-plugin/plugin.json': JSON.stringify({ name: 'tools' }), 'skills/s1/SKILL.md': 'updated' })
    f.installed({ 'tools@market': updated })
    expect(snapshotSkillSource(f.profile, { plugins: [ref] }).plugins).toEqual([])
    f.installed({ 'tools@market': f.tools })
    f.enable({ 'tools@market': false })
    expect(snapshotSkillSource(f.profile, { plugins: [ref] }).revision).toBe(plain.revision)
  })

  it('a chosen plugin gets its own --plugin-dir, without hooks or connectors, and an edit asks for review', () => {
    const f = fixture()
    const selections = createSkillSelectionStore(join(f.root, 'state'))
    const provider = createSkillProvider({ selections, projectionRoot: join(f.root, 'projections') })
    const project = join(f.root, 'project')
    const input = { projectPath: project, destinationAccountId: 'acct-a', destinationGeneration: 1, sourceAccountId: 'default-claude', sourceProfileDir: f.profile }
    expect(() => selections.select({ ...input, includePlugins: ['outside@market'] })).toThrow('installed outside your plugin folder')
    expect(() => selections.select({ ...input, includePlugins: ['off@market'] })).toThrow('is not an enabled plugin')
    const chosen = selections.select({ ...input, includePlugins: ['tools@market'] })
    expect(chosen.includedPlugins).toEqual([{ key: 'tools@market', installPath: f.tools }])
    const launched = provider({ projectPath: project, accountId: 'acct-a', accountGeneration: 1 })!
    expect(launched.pluginDirs).toHaveLength(2)
    const copy = launched.pluginDirs[1]!
    expect(JSON.parse(readFileSync(join(copy, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({ name: 'tools', version: '1.0.0', description: 'W13 fictional tools', commands: ['./commands/a.md'] })
    expect(readFileSync(join(copy, 'skills', 's1', 'SKILL.md'), 'utf8')).toContain('W13 fictional plugin skill')
    for (const absent of ['hooks', '.mcp.json', 'scripts']) expect(existsSync(join(copy, absent))).toBe(false)
    f.write(join(f.tools, 'skills', 's1', 'SKILL.md'), 'edited by an update')
    expect(() => launched.validate()).toThrow(/changed since they were chosen/)
  })
})
