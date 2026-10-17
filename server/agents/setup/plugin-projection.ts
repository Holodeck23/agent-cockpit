// The skills, commands and agents of plugins the user enabled in their CLI default profile (W13 U6),
// without the rest of the plugin. Passing a plugin's own folder would also load its hooks and
// connectors, which nobody reviewed here; instead the host copies only skills/, commands/ and
// agents/ under the plugin's own name, so its namespace (/vercel:deploy) is kept.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { z } from 'zod'

export const PLUGIN_ROOTS = ['skills', 'commands', 'agents'] as const
/** What a stripped manifest keeps. Hooks, connectors, LSP servers and output styles are left out. */
const KEPT_FIELDS = ['name', 'version', 'description'] as const
const LISTED_FIELDS = ['skills', 'commands', 'agents'] as const

/** An enabled plugin the user may include: its key, and the cache folder it was installed to. */
export interface PluginRef { readonly key: string; readonly installPath: string }
export interface EnabledPlugin extends PluginRef {
  readonly name: string
  readonly version?: string
  /** Present for a plugin that cannot be included: why. */
  readonly problem?: string
}

const installedSchema = z.object({
  plugins: z.record(z.string(), z.array(z.object({ scope: z.string(), installPath: z.string(), version: z.string().optional() }))),
})
const manifestSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i) }).passthrough()

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
/** A manifest path ("./commands/deploy.md") inside the folders a stripped copy holds. */
const copiedPath = (entry: string): boolean => {
  const path = normalize(entry)
  return !isAbsolute(path) && PLUGIN_ROOTS.some((root) => path === root || path.startsWith(`${root}${sep}`))
}
const inside = (dir: string, path: string): boolean => {
  const from = relative(dir, path)
  return from !== '' && !from.startsWith('..') && !isAbsolute(from)
}

/** The plugin's manifest, read without following a link. */
export function readPluginManifest(installPath: string): Record<string, unknown> & { name: string } {
  const file = join(installPath, '.claude-plugin', 'plugin.json')
  if (lstatSync(file).isSymbolicLink()) throw new Error('Its manifest is a link')
  return manifestSchema.parse(readJson(file)) as Record<string, unknown> & { name: string }
}

/**
 * Plugins enabled in the profile's own settings and installed for the user, by key. Builtins ship
 * inside the CLI and have no folder to copy; a folder outside the profile's plugin cache is refused.
 */
export function listEnabledPlugins(profileDir: string): EnabledPlugin[] {
  const settingsFile = join(profileDir, 'settings.json'), installedFile = join(profileDir, 'plugins', 'installed_plugins.json')
  if (!existsSync(settingsFile) || !existsSync(installedFile)) return []
  const enabled = z.object({ enabledPlugins: z.record(z.string(), z.boolean()).optional() }).passthrough().parse(readJson(settingsFile)).enabledPlugins ?? {}
  const installed = installedSchema.parse(readJson(installedFile)).plugins
  const cache = existsSync(join(profileDir, 'plugins', 'cache')) ? realpathSync(join(profileDir, 'plugins', 'cache')) : undefined
  const rows: EnabledPlugin[] = []
  for (const key of Object.keys(enabled).filter((name) => enabled[name] === true).sort()) {
    const fallback = key.split('@')[0] ?? key
    if (key.endsWith('@builtin')) continue
    const entry = installed[key]?.find((row) => row.scope === 'user')
    if (!entry) { rows.push({ key, installPath: '', name: fallback, problem: 'not installed for you' }); continue }
    let installPath: string
    try { installPath = realpathSync(entry.installPath) } catch { rows.push({ key, installPath: '', name: fallback, problem: 'its folder is missing' }); continue }
    if (!cache || !inside(cache, installPath)) { rows.push({ key, installPath, name: fallback, problem: 'installed outside your plugin folder' }); continue }
    try {
      const manifest = readPluginManifest(installPath)
      rows.push({ key, installPath, name: manifest.name, ...(typeof manifest.version === 'string' ? { version: manifest.version } : entry.version ? { version: entry.version } : {}) })
    } catch { rows.push({ key, installPath, name: fallback, problem: 'its manifest cannot be read' }) }
  }
  // Two plugins with one name would load under the same namespace: neither is offered.
  const names = rows.filter((row) => !row.problem).map((row) => row.name)
  return rows.map((row) => (!row.problem && names.filter((name) => name === row.name).length > 1 ? { ...row, problem: 'another enabled plugin has the same name' } : row))
}

/**
 * The manifest a stripped copy carries: identity, plus listed skill, command and agent paths that stay
 * inside the copied folders. `dropped` names what was left out of the original.
 */
export function strippedManifest(manifest: Record<string, unknown> & { name: string }): { manifest: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [field, value] of Object.entries(manifest)) {
    if ((KEPT_FIELDS as readonly string[]).includes(field)) { kept[field] = value; continue }
    if ((LISTED_FIELDS as readonly string[]).includes(field)) {
      const listed: unknown[] = Array.isArray(value) ? value : [value]
      const within = listed.filter((entry): entry is string => typeof entry === 'string' && copiedPath(entry))
      if (within.length !== listed.length) dropped.push(field)
      if (within.length) kept[field] = Array.isArray(value) ? within : within[0]
      continue
    }
    if (!['author', 'homepage', 'repository', 'license', 'keywords'].includes(field)) dropped.push(field)
  }
  return { manifest: kept, dropped }
}

/** What the full plugin carries that a stripped copy leaves out, for the review. */
export function pluginLeftOut(installPath: string, manifest: Record<string, unknown>): { hooks: boolean; connectors: boolean } {
  const has = (name: string): boolean => existsSync(join(installPath, name))
  return { hooks: has('hooks') || manifest.hooks !== undefined, connectors: has('.mcp.json') || manifest.mcpServers !== undefined }
}

/**
 * Top-level entries a stripped copy holds, for the review: skill folders, command and agent files, or the
 * manifest's own list where it names them (a plugin may ship more files than it declares).
 */
export function pluginEntries(installPath: string, manifest: Record<string, unknown>): { skills: number; commands: number; agents: number } {
  const count = (root: (typeof PLUGIN_ROOTS)[number], match: (name: string, dir: string) => boolean): number => {
    const listed = manifest[root]
    if (Array.isArray(listed)) return listed.filter((entry) => typeof entry === 'string' && copiedPath(entry)).length
    const dir = join(installPath, root)
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return 0
    return readdirSync(dir).filter((name) => match(name, dir)).length
  }
  return {
    skills: count('skills', (name, dir) => existsSync(join(dir, name, 'SKILL.md'))),
    commands: count('commands', (name) => name.endsWith('.md')),
    agents: count('agents', (name) => name.endsWith('.md')),
  }
}
