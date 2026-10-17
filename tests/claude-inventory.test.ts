import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug, inventoryClaudeSetup, summarizeClaudeInventory } from '../server/agents/setup/claude-inventory.ts'

// W13 U2b: the expected inventory of a Claude setup, read without executing, initializing or writing
// anything. Every kind the plain CLI can load is listed; refused sources stay visible as problems.

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name), key = join(rel, name), stat = lstatSync(path)
      out[key] = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : createHash('sha256').update(readFileSync(path)).digest('hex')
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path, key)
    }
  }
  walk(dir, '')
  return out
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-claude-inventory-')))
  const home = join(root, 'home'), profileDir = join(home, '.claude'), workspaceRoot = join(root, 'repo'), cwd = join(workspaceRoot, 'app')
  const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
  const guard = join(root, 'guard.sh')
  write(guard, '#!/bin/sh\nexit 0\n'); chmodSync(guard, 0o755)
  // A plugin with its own skill and agent, enabled from profile settings.
  const plugin = join(profileDir, 'plugins', 'cache', 'market', 'demo', '1.0.0')
  write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo-tools' }))
  write(join(plugin, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\n---\nplugin lint')
  write(join(plugin, 'agents', 'helper.md'), 'plugin agent')
  write(join(profileDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'demo@market': [{ scope: 'user', installPath: plugin }], 'gone@market': [] } }))
  write(join(profileDir, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'demo@market': true, 'gone@market': true },
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: guard }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'npx some-dynamic-hook' }] }],
    },
  }))
  write(join(profileDir, 'CLAUDE.md'), 'profile rules')
  write(join(profileDir, 'rules', 'common', 'style.md'), 'style')
  write(join(profileDir, 'skills', 'deploy', 'SKILL.md'), 'profile deploy')
  write(join(profileDir, 'commands', 'git', 'commit.md'), 'legacy command')
  write(join(profileDir, 'agents', 'reviewer.md'), 'profile agent')
  write(join(profileDir, 'projects', claudeProjectSlug(cwd), 'memory', 'MEMORY.md'), '# memory')
  // Project setup at the workspace root and the nested cwd, with a same-name skill.
  write(join(workspaceRoot, 'CLAUDE.md'), 'repo rules')
  write(join(workspaceRoot, '.claude', 'skills', 'deploy', 'SKILL.md'), 'project deploy')
  write(join(cwd, '.claude', 'rules', 'local.md'), 'nested rules')
  write(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://example.invalid/mcp' } } }))
  const input = { home, profileDir, workspaceRoot, cwd, pathEnv: '/usr/bin:/bin' }
  return { root, home, profileDir, workspaceRoot, cwd, plugin, input, write }
}

const names = (inventory: ReturnType<typeof inventoryClaudeSetup>, kind: string): string[] =>
  inventory.capabilities.filter((c) => c.kind === kind).map((c) => c.nativeName).sort()

describe('Claude expected inventory (W13 U2b)', () => {
  it('lists every loadable kind from profile, ancestors and enabled plugins', () => {
    const f = fixture()
    const inventory = inventoryClaudeSetup(f.input)
    expect(names(inventory, 'skill')).toEqual(['demo-tools:lint', 'deploy', 'deploy', 'git:commit'])
    expect(names(inventory, 'agent')).toEqual(['demo-tools:helper', 'reviewer'])
    expect(names(inventory, 'instruction')).toEqual(['CLAUDE.md', 'CLAUDE.md', 'rules/common/style.md', 'rules/local.md'])
    expect(names(inventory, 'memory')).toEqual(['MEMORY.md'])
    // The broken plugin may carry MCP servers too, so it stays listed as an unavailable MCP source.
    expect(names(inventory, 'mcp')).toEqual(['gone@market', 'remote'])
    expect(inventory.capabilities.find((c) => c.kind === 'mcp' && c.nativeName === 'gone@market')?.unavailableReason).toBeTruthy()
    // Nothing is chosen or approved by discovery.
    expect(inventory.capabilities.every((c) => !c.selected && !c.approved)).toBe(true)
  })

  it('keeps same-name items from different sources distinct, without deciding precedence', () => {
    const inventory = inventoryClaudeSetup(fixture().input)
    const deploys = inventory.capabilities.filter((c) => c.nativeName === 'deploy')
    expect(deploys).toHaveLength(2)
    expect(new Set(deploys.map((c) => c.id)).size).toBe(2)
    expect(deploys.some((c) => c.shadowedBy)).toBe(false)
  })

  it('lists a resolvable policy hook as reviewable, with nothing unavailable', () => {
    const f = fixture()
    const settings = JSON.parse(readFileSync(join(f.profileDir, 'settings.json'), 'utf8')) as { hooks: Record<string, unknown> }
    delete settings.hooks.SessionStart
    f.write(join(f.profileDir, 'settings.json'), JSON.stringify({ ...settings, enabledPlugins: { 'demo@market': true } }))
    const hooks = inventoryClaudeSetup(f.input).capabilities.filter((c) => c.kind === 'hook')
    expect(hooks).toHaveLength(1)
    expect(hooks[0]).toMatchObject({ nativeName: 'PreToolUse:guard.sh', role: 'policy', requiredEvidence: 'policy-denial' })
    expect(hooks[0]?.unavailableReason).toBeUndefined()
  })

  it('keeps every hook visible as unavailable when the strict parser refuses one of them', () => {
    const inventory = inventoryClaudeSetup(fixture().input)
    const hooks = inventory.capabilities.filter((c) => c.kind === 'hook')
    expect(hooks.find((c) => c.nativeName.startsWith('PreToolUse:'))).toMatchObject({ role: 'policy', requiredEvidence: 'policy-denial' })
    const dynamic = hooks.find((c) => c.nativeName.startsWith('SessionStart:'))
    expect(dynamic?.unavailableReason).toBeTruthy()
    expect(inventory.problems).toContainEqual({ kind: 'plugin', scope: 'profile', reason: 'enabled plugin gone@market has no single installed source' })
  })

  it('reports a source a parser refuses, and lists a linked skill (the CLI follows it) for review', () => {
    const f = fixture()
    f.write(join(f.cwd, '.mcp.json'), '{not json')
    const elsewhere = join(f.root, 'elsewhere-skill')
    f.write(join(elsewhere, 'SKILL.md'), 'linked')
    symlinkSync(elsewhere, join(f.profileDir, 'skills', 'linked'))
    const inventory = inventoryClaudeSetup(f.input)
    expect(inventory.problems.some((p) => p.kind === 'mcp' && p.reason.startsWith('MCP sources:'))).toBe(true)
    expect(inventory.problems).toContainEqual({ kind: 'skill', scope: 'profile', reason: 'linked entry listed; review its target before projection: linked' })
    expect(names(inventory, 'skill')).toContain('linked')
  })

  it('counts a profile CLAUDE.md that is a link, like the Cockpit shared-instruction link', () => {
    const f = fixture()
    const shared = join(f.root, 'shared-CLAUDE.md')
    f.write(shared, 'shared rules')
    rmSync(join(f.profileDir, 'CLAUDE.md'))
    symlinkSync(shared, join(f.profileDir, 'CLAUDE.md'))
    const inventory = inventoryClaudeSetup(f.input)
    expect(names(inventory, 'instruction')).toContain('CLAUDE.md')
    expect(inventory.problems).toContainEqual({ kind: 'settings', scope: 'profile', reason: 'linked instruction; review its target before projection' })
  })

  it('follows a measured autoMemoryDirectory in local settings', () => {
    const f = fixture()
    const chosen = join(f.root, 'chosen-memory')
    f.write(join(chosen, 'MEMORY.md'), '# chosen')
    f.write(join(f.cwd, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: chosen }))
    const memory = inventoryClaudeSetup(f.input).capabilities.filter((c) => c.kind === 'memory')
    expect(memory).toHaveLength(1)
    expect(memory[0]?.sourceRevision).toBe(createHash('sha256').update(readFileSync(join(chosen, 'MEMORY.md'))).update('\0').digest('hex'))
  })

  it('reads without writing, and its summary carries counts only', () => {
    const f = fixture()
    const before = tree(f.root)
    const inventory = inventoryClaudeSetup(f.input)
    expect(tree(f.root)).toEqual(before)
    const summary = JSON.stringify(summarizeClaudeInventory(inventory))
    expect(summary).not.toContain(f.root)
    expect(summary).not.toContain('deploy')
    expect(claudeProjectSlug('/work/x.y_z')).toBe('-work-x-y-z')
  })
})
