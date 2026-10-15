import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The provider gets only this filename. MCP credentials belong to the intended server entry. */
export function writePrivateClaudeConfig(mcpConfig: unknown, settings: unknown): { readonly mcpFile: string; readonly settingsFile: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-'))
  try {
    chmodSync(dir, 0o700)
    const mcpFile = join(dir, 'mcp.json')
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(mcpFile, JSON.stringify(mcpConfig), { flag: 'wx', mode: 0o600 })
    writeFileSync(settingsFile, JSON.stringify(settings), { flag: 'wx', mode: 0o600 })
    return { mcpFile, settingsFile, remove: () => rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
