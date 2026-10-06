import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectPlugin, disconnectPlugin, entryFor, hashEntry, PLUGIN_DIR, type AgyMcpOwnership } from '../server/agents/antigravity/mcp-plugin.ts'

// P3 (W10-04): Antigravity gets Cockpit's tools through a workspace plugin it discovers itself
// (<project>/.agents/plugins/cockpit/), proven in the order-12 recon. The file holds only the
// command; the session token travels in agy's own environment. Nothing global is written.
const COMMAND = { command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit', args: ['/Applications/Cockpit.app/Contents/Resources/app.asar/dist-electron/mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
const ENTRY = entryFor(COMMAND)

function project(git = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-agy-mcp-'))
  if (git) execFileSync('git', ['init', '-q', dir])
  return dir
}
const plugin = (root: string, file = ''): string => join(root, PLUGIN_DIR, file)
const config = (root: string): { mcpServers: Record<string, unknown> } & Record<string, unknown> => JSON.parse(readFileSync(plugin(root, 'mcp_config.json'), 'utf8'))
const ok = (result: ReturnType<typeof connectPlugin>): AgyMcpOwnership => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.ownership
}

describe('connect (W10-04)', () => {
  it('writes a self-describing plugin with no secret, ignored by Git, and nothing outside the project', () => {
    const home = mkdtempSync(join(tmpdir(), 'cockpit-agy-home-'))
    const root = project()
    const ownership = ok(connectPlugin(root, ENTRY, { mode: 'connect', home }))
    expect(ownership).toEqual({ entryHash: hashEntry(ENTRY), created: ['.agents', '.agents/plugins'] })
    expect(config(root)).toEqual({ mcpServers: { cockpit: { command: COMMAND.command, args: COMMAND.args, env: { ELECTRON_RUN_AS_NODE: '1' } } } })
    expect(JSON.parse(readFileSync(plugin(root, 'plugin.json'), 'utf8')).description).toMatch(/Managed by Cockpit/)
    const bytes = readdirSync(plugin(root)).map((f) => readFileSync(plugin(root, f), 'utf8')).join('\n')
    expect(bytes).not.toMatch(/COCKPIT_MCP_(TOKEN|URL)|token/i)
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })).toBe('')
    expect(readdirSync(home)).toEqual([])
  })

  it('changes nothing when the entry is already as Cockpit wrote it', () => {
    const root = project()
    const first = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    const again = connectPlugin(root, ENTRY, { mode: 'connect', owned: first })
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(readdirSync(plugin(root)).sort()).toEqual(['.gitignore', 'mcp_config.json', 'plugin.json'])
  })

  it('updates only its own server, keeps the rest, and backs up the bytes it replaced', () => {
    const root = project()
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    const before = JSON.stringify({ mcpServers: { cockpit: { command: '/old/Cockpit', args: [] }, mine: { command: 'my-server' } }, note: 'kept' }, null, 2)
    writeFileSync(plugin(root, 'mcp_config.json'), before)
    const result = connectPlugin(root, ENTRY, { mode: 'connect', owned })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect(config(root)).toEqual({ mcpServers: { cockpit: ENTRY, mine: { command: 'my-server' } }, note: 'kept' })
    if (!result.ok || !result.backup) throw new Error('expected a backup')
    expect(readFileSync(result.backup, 'utf8')).toBe(before)
  })

  it('leaves a malformed config byte for byte and says where it is', () => {
    const root = project()
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    writeFileSync(plugin(root, 'mcp_config.json'), '{ "mcpServers": { oops')
    const result = connectPlugin(root, ENTRY, { mode: 'connect', owned })
    expect(result).toMatchObject({ ok: false, code: 'malformed' })
    if (!result.ok) expect(result.message).toContain(plugin(root, 'mcp_config.json'))
    expect(readFileSync(plugin(root, 'mcp_config.json'), 'utf8')).toBe('{ "mcpServers": { oops')
  })

  it('refuses a cockpit plugin that is not Cockpit’s', () => {
    const root = project()
    mkdirSync(plugin(root), { recursive: true })
    writeFileSync(plugin(root, 'plugin.json'), '{"name":"cockpit","description":"a team plugin"}')
    expect(connectPlugin(root, ENTRY, { mode: 'connect' })).toMatchObject({ ok: false, code: 'collision' })
    expect(readdirSync(plugin(root))).toEqual(['plugin.json'])
  })

  it('refuses a plugin folder reached through a link out of the project', () => {
    const root = project()
    const elsewhere = mkdtempSync(join(tmpdir(), 'cockpit-agy-elsewhere-'))
    symlinkSync(elsewhere, join(root, '.agents'))
    expect(connectPlugin(root, ENTRY, { mode: 'connect' })).toMatchObject({ ok: false, code: 'unsafe_path' })
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('does not overwrite an edit made while it was connecting', () => {
    const root = project()
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    writeFileSync(plugin(root, 'mcp_config.json'), JSON.stringify({ mcpServers: { cockpit: { command: '/old' } } }))
    const concurrent = JSON.stringify({ mcpServers: { cockpit: { command: '/old' }, added: { command: 'x' } } })
    const result = connectPlugin(root, ENTRY, { mode: 'connect', owned, beforeCommit: () => writeFileSync(plugin(root, 'mcp_config.json'), concurrent) })
    expect(result).toMatchObject({ ok: false, code: 'changed' })
    expect(readFileSync(plugin(root, 'mcp_config.json'), 'utf8')).toBe(concurrent)
  })

  it('at launch, leaves an entry someone else changed and says so', () => {
    const root = project()
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    writeFileSync(plugin(root, 'mcp_config.json'), JSON.stringify({ mcpServers: { cockpit: { command: '/edited/by/hand' } } }))
    expect(connectPlugin(root, ENTRY, { mode: 'launch', owned })).toMatchObject({ ok: false, code: 'changed' })
    expect(config(root).mcpServers.cockpit).toEqual({ command: '/edited/by/hand' })
    // A launch recreates its own plugin if it was deleted.
    const fresh = project()
    expect(connectPlugin(fresh, ENTRY, { mode: 'launch', owned })).toMatchObject({ ok: true, changed: true })
  })
})

describe('disconnect (W10-04)', () => {
  it('removes everything it created and nothing it did not', () => {
    const root = project()
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true })
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    expect(owned.created).toEqual(['.agents/plugins'])
    expect(disconnectPlugin(root, owned)).toMatchObject({ ok: true, removed: true })
    expect(existsSync(join(root, '.agents', 'plugins'))).toBe(false)
    expect(existsSync(join(root, '.agents', 'skills'))).toBe(true)
  })

  it('removes only its own unchanged server and keeps the others', () => {
    const root = project(false)
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    writeFileSync(plugin(root, 'mcp_config.json'), JSON.stringify({ mcpServers: { cockpit: ENTRY, mine: { command: 'my-server' } } }))
    expect(disconnectPlugin(root, owned)).toMatchObject({ ok: true, removed: true })
    expect(config(root)).toEqual({ mcpServers: { mine: { command: 'my-server' } } })
  })

  it('leaves an entry changed since Cockpit wrote it, and a malformed file, untouched', () => {
    const root = project(false)
    const owned = ok(connectPlugin(root, ENTRY, { mode: 'connect' }))
    const edited = JSON.stringify({ mcpServers: { cockpit: { command: '/edited' } } })
    writeFileSync(plugin(root, 'mcp_config.json'), edited)
    const result = disconnectPlugin(root, owned)
    expect(result).toMatchObject({ ok: true, removed: false })
    if (result.ok) expect(result.message).toMatch(/changed since Cockpit wrote it/)
    expect(readFileSync(plugin(root, 'mcp_config.json'), 'utf8')).toBe(edited)
    writeFileSync(plugin(root, 'mcp_config.json'), 'not json')
    expect(disconnectPlugin(root, owned)).toMatchObject({ ok: true, removed: false })
    expect(readFileSync(plugin(root, 'mcp_config.json'), 'utf8')).toBe('not json')
  })
})
