import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** The provider gets only this filename. MCP credentials belong to the intended server entry. */
export function writePrivateClaudeConfig(mcpConfig: unknown, settings: Readonly<Record<string, unknown>>, nativeMemoryDirectory?: string):
  { readonly mcpFile: string; readonly settingsFile: string; remove(): void } {
  if ('autoMemoryDirectory' in settings) throw new Error('Claude native memory must be selected separately from hook settings')
  if (nativeMemoryDirectory !== undefined) {
    if (!isAbsolute(nativeMemoryDirectory)) throw new Error('Claude native memory directory must be absolute')
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(nativeMemoryDirectory) }
    catch { throw new Error('Claude native memory directory is unavailable') }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error('Claude native memory directory must be private and unlinked')
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-'))
  try {
    chmodSync(dir, 0o700)
    const mcpFile = join(dir, 'mcp.json')
    const settingsFile = join(dir, 'settings.json')
    writeFileSync(mcpFile, JSON.stringify(mcpConfig), { flag: 'wx', mode: 0o600 })
    writeFileSync(settingsFile, JSON.stringify({ ...settings,
      ...(nativeMemoryDirectory === undefined ? {} : { autoMemoryDirectory: nativeMemoryDirectory }) }), { flag: 'wx', mode: 0o600 })
    return { mcpFile, settingsFile, remove: () => rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
