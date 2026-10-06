// P3: Cockpit's tools for Antigravity, per project and only when the user turns it on (W10.1).
// `agy mcp add` writes the global ~/.gemini/config/mcp_config.json, so it is not used. agy also
// discovers workspace plugins under <project>/.agents/plugins/<name>/, and spawns a plugin's stdio
// server itself, with agy's own environment (order-12 recon, agy 1.3.0). So the plugin file holds
// only the command, and the session token travels in agy's launch environment, never in a file.
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpCommand } from '../../mcp/sessions.ts'

export const PLUGIN_DIR = join('.agents', 'plugins', 'cockpit')
const SERVER = 'cockpit'
const MARKER = 'Managed by Cockpit'
const MANIFEST = `${JSON.stringify({ name: 'cockpit', description: `Cockpit's tools for Antigravity sessions started from Cockpit. ${MARKER}: turn it off in the project's settings in Cockpit.` }, null, 2)}\n`
// The plugin ignores itself: nothing appears in the project's Git status, and no repo file is edited.
const GITIGNORE = '*\n'
const PARENTS = ['.agents', '.agents/plugins'] as const

export interface AgyMcpEntry {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** What Cockpit wrote, kept in its own project record: Disconnect removes only this, unchanged. */
export interface AgyMcpOwnership {
  readonly entryHash: string
  /** Parent folders Cockpit created, removed again on Disconnect when empty. */
  readonly created: readonly (typeof PARENTS)[number][]
}

export type PluginFailure = { readonly ok: false; readonly code: 'collision' | 'malformed' | 'changed' | 'unsafe_path'; readonly message: string }
export type ConnectResult = { readonly ok: true; readonly ownership: AgyMcpOwnership; readonly changed: boolean; readonly backup?: string } | PluginFailure
export type DisconnectResult = { readonly ok: true; readonly removed: boolean; readonly message?: string } | PluginFailure

export interface ConnectOptions {
  /** `connect`: the user's explicit action, may replace Cockpit's own entry. `launch`: only create or keep. */
  readonly mode: 'connect' | 'launch'
  readonly owned?: AgyMcpOwnership
  /** Test seam: runs between reading the config and replacing it. */
  readonly beforeCommit?: () => void
  /** Unused by the plugin; tests pass it to prove nothing lands in the home folder. */
  readonly home?: string
}

/** Only the non-secret part of the MCP launch: the per-session URL and token are never written. */
export function entryFor(command: McpCommand): AgyMcpEntry {
  const env = command.env && Object.keys(command.env).length > 0 ? { env: { ...command.env } } : {}
  return { command: command.command, args: [...command.args], ...env }
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v)
export const hashEntry = (entry: unknown): string => createHash('sha256').update(canonical(entry)).digest('hex')

const fail = (code: PluginFailure['code'], message: string): PluginFailure => ({ ok: false, code, message })

/** Every folder on the way must be a real folder inside the project, never a link out of it. */
function unsafeFolder(root: string): string | undefined {
  const parts = PLUGIN_DIR.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const path = join(root, ...parts.slice(0, i))
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return path
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Bytes of a plain file, undefined when absent; a link or folder in its place is refused. */
function readPlain(file: string): string | undefined | Error {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile()) return new Error(`${file} is not a plain file`)
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Replaces `file` only if it still holds `expected` (undefined: still absent). */
function commit(file: string, text: string, expected: string | undefined, beforeCommit?: () => void): boolean {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, text, { flag: 'wx', mode: 0o644 })
  beforeCommit?.()
  const now = readPlain(file)
  if (now !== expected) { unlinkSync(temp); return false }
  renameSync(temp, file)
  return true
}

type Parsed = { readonly servers: Record<string, unknown>; readonly rest: Record<string, unknown> }
function parseConfig(text: string): Parsed | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const { mcpServers, ...rest } = value as Record<string, unknown>
    if (mcpServers !== undefined && (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers))) return undefined
    return { servers: { ...(mcpServers as Record<string, unknown> | undefined) }, rest }
  } catch {
    return undefined
  }
}
const render = (parsed: Parsed): string => `${JSON.stringify({ mcpServers: parsed.servers, ...parsed.rest }, null, 2)}\n`

function isOurs(manifest: string | undefined | Error): boolean {
  if (typeof manifest !== 'string') return false
  try {
    const value = JSON.parse(manifest) as { description?: unknown }
    return typeof value.description === 'string' && value.description.includes(MARKER)
  } catch {
    return false
  }
}

export function connectPlugin(root: string, entry: AgyMcpEntry, options: ConnectOptions): ConnectResult {
  const dir = join(root, PLUGIN_DIR)
  const unsafe = unsafeFolder(root)
  if (unsafe) return fail('unsafe_path', `${unsafe} is a link or a file, not a folder in this project. Cockpit writes only inside the project and left it alone.`)
  const created = PARENTS.filter((parent) => { try { lstatSync(join(root, parent)); return false } catch { return true } })
  let exists = true
  try { lstatSync(dir) } catch { exists = false }
  if (exists) {
    const manifest = readPlain(join(dir, 'plugin.json'))
    if (!isOurs(manifest) && readdirSync(dir).length > 0) {
      return fail('collision', `${dir} already holds a plugin that is not Cockpit's. Cockpit left it as it is; rename it to connect Cockpit's tools.`)
    }
  }
  mkdirSync(dir, { recursive: true })
  const ownership: AgyMcpOwnership = { entryHash: hashEntry(entry), created: [...new Set([...(options.owned?.created ?? []), ...created])] }
  if (readPlain(join(dir, 'plugin.json')) === undefined) commit(join(dir, 'plugin.json'), MANIFEST, undefined)
  if (readPlain(join(dir, '.gitignore')) === undefined) commit(join(dir, '.gitignore'), GITIGNORE, undefined)

  const file = join(dir, 'mcp_config.json')
  const before = readPlain(file)
  if (before instanceof Error) return fail('unsafe_path', `${before.message}. Cockpit left it alone.`)
  const parsed = before === undefined ? { servers: {}, rest: {} } : parseConfig(before)
  if (!parsed) return fail('malformed', `${file} is not a valid MCP config. Cockpit left its bytes unchanged; fix or remove it, then connect again.`)
  const current = parsed.servers[SERVER]
  if (current !== undefined && hashEntry(current) === ownership.entryHash) return { ok: true, ownership, changed: false }
  if (current !== undefined && options.mode === 'launch' && hashEntry(current) !== options.owned?.entryHash) {
    return fail('changed', `Cockpit's entry in ${file} was changed outside Cockpit, so this session starts without Cockpit's tools. Connect again in the project's settings to replace it.`)
  }
  let backup: string | undefined
  if (before !== undefined && current !== undefined) {
    backup = `${file}.cockpit-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    writeFileSync(backup, before, { flag: 'wx', mode: 0o600 })
  }
  const next = render({ servers: { ...parsed.servers, [SERVER]: entry }, rest: parsed.rest })
  if (!commit(file, next, before, options.beforeCommit)) {
    return fail('changed', `${file} changed while Cockpit was connecting. Nothing was replaced; try again.`)
  }
  return { ok: true, ownership, changed: true, ...(backup ? { backup } : {}) }
}

export function disconnectPlugin(root: string, owned: AgyMcpOwnership): DisconnectResult {
  const dir = join(root, PLUGIN_DIR)
  const unsafe = unsafeFolder(root)
  if (unsafe) return fail('unsafe_path', `${unsafe} is a link or a file; Cockpit left it alone.`)
  try { lstatSync(dir) } catch { return { ok: true, removed: false } }
  if (!isOurs(readPlain(join(dir, 'plugin.json')))) return fail('collision', `${dir} is not Cockpit's plugin; Cockpit left it as it is.`)
  const file = join(dir, 'mcp_config.json')
  const before = readPlain(file)
  if (before instanceof Error) return fail('unsafe_path', `${before.message}. Cockpit left it alone.`)
  if (before !== undefined) {
    const parsed = parseConfig(before)
    if (!parsed) return { ok: true, removed: false, message: `${file} is not valid JSON, so Cockpit left it unchanged. Antigravity sessions from Cockpit no longer get Cockpit's tools.` }
    const current = parsed.servers[SERVER]
    if (current !== undefined && hashEntry(current) !== owned.entryHash) {
      return { ok: true, removed: false, message: `Cockpit's entry in ${file} changed since Cockpit wrote it, so it was left in place. Antigravity sessions from Cockpit no longer get Cockpit's tools.` }
    }
    const { [SERVER]: _ours, ...others } = parsed.servers
    if (Object.keys(others).length > 0 || Object.keys(parsed.rest).length > 0) {
      if (!commit(file, render({ servers: others, rest: parsed.rest }), before)) return fail('changed', `${file} changed while Cockpit was disconnecting. Nothing was removed; try again.`)
      return { ok: true, removed: true }
    }
    unlinkSync(file)
  }
  // Only Cockpit's own files left: the plugin goes, and any parent folder Cockpit made, if empty.
  const left = readdirSync(dir)
  if (left.every((name) => name === 'plugin.json' || name === '.gitignore')) {
    for (const name of left) unlinkSync(join(dir, name))
    rmdirSync(dir)
    for (const parent of [...PARENTS].reverse()) {
      if (!owned.created.includes(parent)) continue
      try { rmdirSync(join(root, parent)) } catch { /* not empty: someone else's files are in it */ }
    }
  }
  return { ok: true, removed: true }
}
