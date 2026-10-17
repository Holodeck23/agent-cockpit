import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildClaudeArgs } from '../server/agents/claude/flags.ts'
import { writePrivateClaudeConfig } from '../server/agents/claude/private-config.ts'

it('passes a selected native memory overlay through private settings without changing hook choice', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-native-memory-settings-'))
  const overlay = join(root, 'overlay')
  mkdirSync(overlay, { mode: 0o700 })
  const config = writePrivateClaudeConfig({ mcpServers: {} }, { disableAllHooks: true }, overlay)
  try {
    const settings = JSON.parse(readFileSync(config.settingsFile, 'utf8')) as Record<string, unknown>
    expect(settings).toEqual({ disableAllHooks: true, autoMemoryDirectory: overlay })
    expect(readFileSync(config.mcpFile, 'utf8')).toBe('{"mcpServers":{}}')
    const args = buildClaudeArgs({ cwd: root, mcpConfigFile: config.mcpFile, settingsFile: config.settingsFile })
    expect(args).toContain('--strict-mcp-config')
    expect(args.join(' ')).not.toContain(overlay)
  } finally { config.remove() }
})

it('rejects linked or shared memory paths and a hook snapshot that tries to set memory', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-native-memory-settings-'))
  const overlay = join(root, 'overlay')
  mkdirSync(overlay, { mode: 0o700 })
  const linked = join(root, 'linked')
  symlinkSync(overlay, linked)
  expect(() => writePrivateClaudeConfig({}, {}, linked)).toThrow(/private and unlinked/)
  expect(() => writePrivateClaudeConfig({}, {}, join(root, 'missing'))).toThrow('Claude native memory directory is unavailable')
  chmodSync(overlay, 0o755)
  expect(() => writePrivateClaudeConfig({}, {}, overlay)).toThrow(/private and unlinked/)
  expect(() => writePrivateClaudeConfig({}, {}, '')).toThrow(/must be absolute/)
  expect(() => writePrivateClaudeConfig({}, { autoMemoryDirectory: overlay })).toThrow(/selected separately/)
})
