import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPlugin, disconnectPlugin, entryFor, PLUGIN_DIR } from '../../server/agents/antigravity/mcp-plugin.ts'
import { createAgyMcp } from '../../server/projects/agy-mcp.ts'
import { createProjectStore } from '../../server/projects/store.ts'

// Review of u03: only connectPlugin got the file-system-error guard. Disconnect on a read-only or
// unreadable plugin folder threw out of setConnected(path, false). And a connect that failed after it
// made the plugin's folders recorded no ownership of them, so a later Disconnect left them behind.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

const ENTRY = entryFor({ command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit', args: ['mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } })
const asRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0
const folder = (): string => mkdtempSync(join(tmpdir(), 'cockpit-review-agy-'))
const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) { try { chmodSync(path, 0o755) } catch { /* gone */ } }
  vi.mocked(fs.writeFileSync).mockClear()
})

/** The next write leaves a partial file behind and then fails, the way a full disk does. */
function fullDiskOnNextWrite(): void {
  const real = vi.mocked(fs.writeFileSync).getMockImplementation()!
  vi.mocked(fs.writeFileSync).mockImplementationOnce((file, data, options) => {
    real(file, String(data).slice(0, 3), options)
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  })
}

describe('review: disconnecting the Antigravity plugin on a folder that cannot be written', () => {
  it.skipIf(asRoot())('a read-only plugin folder is a message, and the project stays connected', () => {
    const root = folder()
    const projects = createProjectStore(mkdtempSync(join(tmpdir(), 'cockpit-review-agy-state-')))
    projects.open(root)
    const agy = createAgyMcp(projects, { command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit', args: ['mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(agy.setConnected(root, true)).toMatchObject({ ok: true })
    const dir = join(root, PLUGIN_DIR)
    cleanup.push(dir)
    chmodSync(dir, 0o555)

    let result: ReturnType<typeof agy.setConnected> | undefined
    expect(() => { result = agy.setConnected(root, false) }).not.toThrow()
    expect(result).toMatchObject({ ok: false, code: 'unsafe_path' })
    expect((result as { message: string }).message).toContain(dir)
    expect(projects.list().find((p) => p.path === root)?.antigravityMcp).toBeDefined()
  })

  it.skipIf(asRoot())('an unreadable config file is a message, not a throw', () => {
    const root = folder()
    const owned = (() => { const r = connectPlugin(root, ENTRY, { mode: 'connect' }); if (!r.ok) throw new Error(r.message); return r.ownership })()
    const config = join(root, PLUGIN_DIR, 'mcp_config.json')
    cleanup.push(config)
    chmodSync(config, 0o000)
    expect(disconnectPlugin(root, owned)).toMatchObject({ ok: false, code: 'unsafe_path' })
  })
})

describe('review: a connect that fails after making folders leaves nothing unrecorded behind', () => {
  it('a full disk while writing the manifest takes back the folders and the half-written file', () => {
    const root = folder()
    fullDiskOnNextWrite()
    const result = connectPlugin(root, ENTRY, { mode: 'connect' })
    expect(result).toMatchObject({ ok: false, code: 'unsafe_path' })
    expect(existsSync(join(root, '.agents'))).toBe(false)

    // A later Connect works from a clean start, records both folders, and Disconnect removes them again.
    const again = connectPlugin(root, ENTRY, { mode: 'connect' })
    if (!again.ok) throw new Error(again.message)
    expect(again.ownership.created).toEqual(['.agents', '.agents/plugins'])
    expect(disconnectPlugin(root, again.ownership)).toMatchObject({ ok: true, removed: true })
    expect(existsSync(join(root, '.agents'))).toBe(false)
  })

  it('folders that were already there are left as they were', () => {
    const root = folder()
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents', 'mine.txt'), 'keep')
    fullDiskOnNextWrite()
    expect(connectPlugin(root, ENTRY, { mode: 'connect' })).toMatchObject({ ok: false })
    expect(readdirSync(join(root, '.agents'))).toEqual(['mine.txt'])
  })

  it('a failure on the second file takes back the first, so no plugin folder is left unrecorded', () => {
    const root = folder()
    const real = vi.mocked(fs.writeFileSync).getMockImplementation()!
    // plugin.json is written normally; the .gitignore write fails.
    vi.mocked(fs.writeFileSync).mockImplementationOnce(real)
    fullDiskOnNextWrite()
    expect(connectPlugin(root, ENTRY, { mode: 'connect' })).toMatchObject({ ok: false })
    expect(existsSync(join(root, '.agents'))).toBe(false)
  })
})
