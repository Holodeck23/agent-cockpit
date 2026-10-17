// Read-only expected inventory of a Claude setup: what the plain CLI could load for this profile and
// workspace. Nothing is executed, initialized, written or resolved through an account. A parser that
// refuses a source becomes a visible problem, never a silent gap. Native precedence is not decided
// here: same-name items stay separate until a measured rule says which one wins.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { snapshotHookSources } from '../claude/hook-sources.ts'
import { snapshotMcpSources } from '../claude/mcp-sources.ts'
import { scoutClaudeSources, type ClaudeSourceCandidate } from './claude-source-scout.ts'
import type { SetupCapability, SetupKind } from './manifest.ts'

/** Hook events whose handler can stop or rewrite an action; losing one silently fails open. */
const POLICY_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStop'])
const MAX_ENTRIES = 2000

export interface ClaudeInventoryProblem {
  readonly kind: SetupKind | 'plugin' | 'settings' | 'policy'
  readonly scope: ClaudeSourceCandidate['scope']
  readonly reason: string
}
export interface ClaudeInventory {
  readonly capabilities: readonly SetupCapability[]
  readonly problems: readonly ClaudeInventoryProblem[]
  /** Private host data: locators and candidate states. */
  readonly candidates: readonly ClaudeSourceCandidate[]
}
export interface ClaudeInventoryInput {
  readonly home: string
  readonly profileDir: string
  readonly workspaceRoot: string
  readonly cwd: string
  readonly pathEnv: string
}

const sha = (...parts: readonly (string | Buffer)[]): string => {
  const digest = createHash('sha256')
  for (const part of parts) digest.update(part).update('\0')
  return digest.digest('hex')
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Claude's per-project folder name: every character outside [A-Za-z0-9] becomes '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object')
  return raw as Record<string, unknown>
}

/**
 * Markdown files below a folder. The CLI follows links, so a linked file is listed too and reported
 * for review before any projection; linked folders are reported, never walked (no loops, no escapes).
 */
function markdownFiles(dir: string, onLink: (path: string) => void): string[] {
  const out: string[] = []
  let entries = 0
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      if (++entries > MAX_ENTRIES) throw new Error('too many entries')
      const path = join(at, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        onLink(path)
        if (extname(name) === '.md' && existsSync(path) && statSync(path).isFile()) out.push(path)
        continue
      }
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile() && extname(name) === '.md') out.push(path)
    }
  }
  if (existsSync(dir) && lstatSync(dir).isDirectory()) walk(dir)
  return out
}

export function inventoryClaudeSetup(input: ClaudeInventoryInput): ClaudeInventory {
  const candidates = scoutClaudeSources(input)
  const capabilities: SetupCapability[] = []
  const problems: ClaudeInventoryProblem[] = []
  const add = (kind: SetupKind, nativeName: string, source: string, revision: string,
    extra: Partial<Pick<SetupCapability, 'enabled' | 'role' | 'unavailableReason'>> = {}): void => {
    const role = extra.role ?? 'enrichment'
    capabilities.push({
      id: sha(kind, source, nativeName), kind, nativeName, sourceId: sha(source), sourceRevision: revision,
      enabled: extra.enabled ?? true, selected: false, approved: false, role,
      requiredEvidence: kind === 'hook' ? (role === 'policy' ? 'policy-denial' : 'call')
        : kind === 'mcp' ? 'call' : kind === 'skill' || kind === 'agent' ? 'invocation' : 'load',
      ...(extra.unavailableReason ? { unavailableReason: extra.unavailableReason } : {}),
    })
  }
  const fileRevision = (path: string): string => sha(readFileSync(path))
  const attempt = (kind: ClaudeInventoryProblem['kind'], scope: ClaudeInventoryProblem['scope'], what: string, run: () => void): void => {
    try { run() } catch (error) { problems.push({ kind, scope, reason: `${what}: ${message(error)}` }) }
  }
  const linked = (kind: ClaudeInventoryProblem['kind'], scope: ClaudeInventoryProblem['scope']) => (path: string): void => {
    problems.push({ kind, scope, reason: `linked entry listed; review its target before projection: ${basename(path)}` })
  }

  for (const candidate of candidates) {
    if (candidate.kind === 'policy' && candidate.state !== 'missing') {
      problems.push({ kind: 'policy', scope: 'policy', reason: 'managed policy settings present; they need their own review' })
    }
    if (candidate.state === 'link' && candidate.kind !== 'config-root' && candidate.kind !== 'workspace-root') {
      problems.push({ kind: 'settings', scope: candidate.scope, reason: `linked ${candidate.kind}; review its target before projection` })
    }
  }

  /** Each configured hook command as an unavailable entry, when the strict parser cannot account for them. */
  const listRawHooks = (reason: string): void => {
    const files = [join(input.profileDir, 'settings.json'), join(input.profileDir, 'settings.local.json'),
      join(input.cwd, '.claude', 'settings.json'), join(input.cwd, '.claude', 'settings.local.json')]
    for (const file of files) {
      let hooks: unknown
      try { hooks = readJson(file)?.hooks } catch { continue }
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue
      for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue
        for (const [groupIndex, group] of groups.entries()) {
          const entries = (group as { hooks?: unknown }).hooks
          if (!Array.isArray(entries)) continue
          for (const [index, hook] of entries.entries()) {
            const command = typeof (hook as { command?: unknown }).command === 'string' ? (hook as { command: string }).command : ''
            add('hook', `${event}:${groupIndex}:${index}:${sha(command).slice(0, 12)}`, file, sha(command),
              { role: POLICY_EVENTS.has(event) ? 'policy' : 'enrichment', unavailableReason: `hook sources refused: ${reason}` })
          }
        }
      }
    }
  }

  // Hooks and MCP: the existing strict parsers, so inventory and launch agree on what a source is.
  attempt('hook', 'profile', 'hook sources', () => {
    let hooks: ReturnType<typeof snapshotHookSources>
    try { hooks = snapshotHookSources({ home: input.home, cwd: input.cwd, pathEnv: input.pathEnv, profileDir: input.profileDir }) }
    catch (error) {
      // The launch parser refuses the whole set on one bad entry. Inventory keeps every entry visible instead.
      listRawHooks(message(error))
      throw error
    }
    for (const hook of hooks.review) {
      add('hook', `${hook.event}:${basename(hook.executable)}`, hook.source, sha(hook.executableHash, ...hook.referencedFiles.map((f) => f.hash)),
        { role: POLICY_EVENTS.has(hook.event) ? 'policy' : 'enrichment' })
    }
    for (const gap of hooks.unavailable) {
      add('hook', gap.event ? `${gap.event}:${gap.id}` : gap.id, gap.source, sha(gap.id),
        { role: gap.event && POLICY_EVENTS.has(gap.event) ? 'policy' : 'enrichment', unavailableReason: gap.reason })
    }
  })
  attempt('mcp', 'profile', 'MCP sources', () => {
    const mcp = snapshotMcpSources({ home: input.home, cwd: input.cwd, pathEnv: input.pathEnv, profileDir: input.profileDir })
    for (const server of mcp.review) add('mcp', server.name, server.source, sha(JSON.stringify(mcp.servers[server.name] ?? {})))
    for (const gap of mcp.unavailable) add('mcp', gap.name, gap.source, sha(gap.name), { unavailableReason: gap.reason })
  })

  // Enabled plugins from profile settings: each contributes its own skills, agents and commands.
  const plugins: { id: string; root: string; enabled: boolean }[] = []
  attempt('plugin', 'profile', 'plugin registry', () => {
    const choices = new Map<string, boolean>()
    for (const name of ['settings.json', 'settings.local.json']) {
      const enabled = readJson(join(input.profileDir, name))?.enabledPlugins
      if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
        for (const [id, on] of Object.entries(enabled)) if (typeof on === 'boolean') choices.set(id, on)
      }
    }
    if (choices.size === 0) return
    const registry = readJson(join(input.profileDir, 'plugins', 'installed_plugins.json'))?.plugins as Record<string, unknown> | undefined
    for (const [id, enabled] of choices) {
      const rows = registry?.[id]
      const path = Array.isArray(rows) && rows.length === 1 ? (rows[0] as { installPath?: unknown }).installPath : undefined
      if (typeof path !== 'string' || !existsSync(path)) {
        if (enabled) problems.push({ kind: 'plugin', scope: 'profile', reason: `enabled plugin ${id} has no single installed source` })
        continue
      }
      plugins.push({ id, root: path, enabled })
    }
  })

  // Skills (and legacy commands), agents: profile, each workspace ancestor, then plugins.
  const profileRoots = [{ scope: 'profile' as const, dir: input.profileDir, prefix: '', enabled: true }]
  const projectRoots = candidates.filter((c) => c.kind === 'config-root' && c.state === 'directory')
    .map((c) => ({ scope: 'project' as const, dir: c.path, prefix: '', enabled: true }))
  // Plugin items are namespaced by the plugin manifest's own name, as the CLI invokes them (/name:skill).
  const pluginRoots = plugins.map((p) => {
    let name = p.id.split('@')[0] ?? p.id
    try {
      const declared = readJson(join(p.root, '.claude-plugin', 'plugin.json'))?.name
      if (typeof declared === 'string' && declared) name = declared
    } catch (error) { problems.push({ kind: 'plugin', scope: 'profile', reason: `plugin ${p.id} manifest: ${message(error)}` }) }
    return { scope: 'profile' as const, dir: p.root, prefix: `${name}:`, enabled: p.enabled }
  })
  for (const root of [...profileRoots, ...projectRoots, ...pluginRoots]) {
    const { enabled } = root
    attempt('skill', root.scope, 'skills', () => {
      const skills = join(root.dir, 'skills')
      if (!existsSync(skills) || !lstatSync(skills).isDirectory()) return
      for (const name of readdirSync(skills).sort()) {
        const dir = join(skills, name), entry = join(dir, 'SKILL.md')
        if (lstatSync(dir).isSymbolicLink()) linked('skill', root.scope)(dir)
        if (existsSync(entry)) add('skill', `${root.prefix}${name}`, dir, fileRevision(entry), { enabled })
      }
    })
    attempt('skill', root.scope, 'commands', () => {
      const commands = join(root.dir, 'commands')
      for (const file of markdownFiles(commands, linked('skill', root.scope))) {
        add('skill', `${root.prefix}${relative(commands, file).slice(0, -3).replaceAll('/', ':')}`, file, fileRevision(file), { enabled })
      }
    })
    attempt('agent', root.scope, 'agents', () => {
      for (const file of markdownFiles(join(root.dir, 'agents'), linked('agent', root.scope))) {
        add('agent', `${root.prefix}${basename(file, '.md')}`, file, fileRevision(file), { enabled })
      }
    })
  }

  // Instructions: profile CLAUDE.md and rules; each ancestor's CLAUDE.md variants and rules.
  for (const candidate of candidates) {
    const readable = candidate.state === 'file' || (candidate.state === 'link' && existsSync(candidate.path) && statSync(candidate.path).isFile())
    if (candidate.kind === 'instruction' && readable) {
      add('instruction', basename(candidate.path), candidate.path, fileRevision(candidate.path))
    }
    if (candidate.kind === 'rule-root' && candidate.state === 'directory') {
      attempt('instruction', candidate.scope, 'rules', () => {
        for (const file of markdownFiles(candidate.path, linked('instruction', candidate.scope))) {
          add('instruction', `rules/${relative(candidate.path, file)}`, file, fileRevision(file))
        }
      })
    }
  }

  // Native auto memory: an explicit autoMemoryDirectory wins only where measured (local over project);
  // otherwise the profile's per-project folder.
  attempt('memory', 'profile', 'auto memory', () => {
    const configured = [join(input.cwd, '.claude', 'settings.local.json'), join(input.cwd, '.claude', 'settings.json')]
      .map((file) => readJson(file)?.autoMemoryDirectory).find((value): value is string => typeof value === 'string')
    const dir = configured ?? join(input.profileDir, 'projects', claudeProjectSlug(input.cwd), 'memory')
    const entry = join(dir, 'MEMORY.md')
    if (existsSync(entry)) add('memory', 'MEMORY.md', dir, fileRevision(entry))
  })

  return { capabilities, problems, candidates }
}

/** Counts only: safe to put in shared evidence. */
export function summarizeClaudeInventory(inventory: ClaudeInventory): Record<string, unknown> {
  const count = (rows: readonly SetupCapability[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const row of rows) out[row.kind] = (out[row.kind] ?? 0) + 1
    return out
  }
  return {
    capabilities: count(inventory.capabilities),
    enabled: count(inventory.capabilities.filter((c) => c.enabled)),
    unavailable: count(inventory.capabilities.filter((c) => c.unavailableReason)),
    policyHooks: inventory.capabilities.filter((c) => c.kind === 'hook' && c.role === 'policy').length,
    problems: inventory.problems.map((p) => ({ kind: p.kind, scope: p.scope })),
  }
}
