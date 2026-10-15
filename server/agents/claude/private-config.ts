import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The provider gets only this filename. MCP credentials belong to the intended server entry. */
export function writePrivateMcpConfig(config: unknown): { readonly file: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-'))
  try {
    chmodSync(dir, 0o700)
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
    return { file, remove: () => rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
