import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface HookSourceReview {
  readonly event: string
  readonly source: string
  readonly executable: string
  readonly executableHash: string
  readonly referencedFiles: readonly { readonly path: string; readonly hash: string }[]
}
export interface HookSourceSnapshot {
  readonly revision: string
  /** Passed as the sole explicit --settings snapshot, with ambient settings discovery disabled. */
  readonly settings: Readonly<{ hooks: Readonly<Record<string, readonly unknown[]>> }>
  readonly review: readonly HookSourceReview[]
}
export interface HookSourceInput {
  readonly home: string
  readonly cwd: string
  readonly pathEnv: string
  readonly profileDir?: string
  readonly accountId?: string
  readonly accountGeneration?: number
}

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const readSource = (path: string): Buffer => {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`Review the linked or non-file Claude hook source separately: ${path}`)
  return readFileSync(path)
}
const readObject = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readSource(path).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid Claude hook source: ${path}`)
  return parsed as Record<string, unknown>
}
const executablePath = (command: string, cwd: string, pathEnv: string): string => {
  const candidates = command.includes('/') ? [resolve(cwd, command)] : pathEnv.split(delimiter).map((dir) => resolve(cwd, dir || '.', command))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      if (statSync(real).isFile()) return real
    } catch { /* Keep looking. */ }
  }
  throw new Error(`Claude hook executable is unavailable: ${command}`)
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const within = (root: string, path: string): boolean => {
  const pathFromRoot = relative(root, path)
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

function pinShebang(path: string, bytes: Buffer, cwd: string, pathEnv: string, digest: ReturnType<typeof createHash>): void {
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return
  const line = bytes.toString('utf8', 2, Math.min(bytes.length, 512)).split('\n', 1)[0]?.trim() ?? ''
  const [command] = literalArgv(line)
  if (!command || basename(command) === 'env') throw new Error(`Claude hook shebang has an unpinned runtime: ${path}`)
  const runtime = executablePath(command, cwd, pathEnv)
  digest.update(runtime).update(sha(readSource(runtime)))
}

/** Only literal argv is supported. Shell operators, interpolation, expansion and substitutions need separate review. */
function literalArgv(command: string): string[] {
  if (/[;|&><$`(){}*?\[\]~#\\\n\r]/.test(command)) throw new Error('Claude hook command uses dynamic shell syntax; review it separately')
  const args: string[] = []
  let token = '', quote: '"' | "'" | undefined, active = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (char === quote) quote = undefined
      else { token += char; active = true }
    } else if (char === '"' || char === "'") { quote = char; active = true }
    else if (/\s/.test(char)) { if (active) { args.push(token); token = ''; active = false } }
    else { token += char; active = true }
  }
  if (quote) throw new Error('Claude hook command has an unterminated quote')
  if (active) args.push(token)
  if (args.length === 0) throw new Error('Claude hook command is empty')
  return args
}

/** Conservative source snapshot: unsupported or unresolved executable forms block hooks-on. */
export function snapshotHookSources(input: HookSourceInput): HookSourceSnapshot {
  if (['/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json'].some(existsSync)) {
    throw new Error('Managed Claude settings need a separate hook policy review')
  }
  const profile = input.profileDir ?? join(input.home, '.claude')
  const root = existsSync(profile) ? realpathSync(profile) : resolve(profile)
  const cwd = realpathSync(input.cwd)
  const digest = createHash('sha256').update(cwd).update(root)
    .update(input.accountId ?? 'default-claude').update(String(input.accountGeneration ?? 1))
  const hooks: Record<string, unknown[]> = {}
  const plugins = new Map<string, boolean>()
  const review: HookSourceReview[] = []
  const add = (source: string, raw: unknown, pluginRoot?: string): void => {
    if (raw === undefined) return
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid Claude hooks: ${source}`)
    digest.update(source).update(JSON.stringify(raw))
    for (const [event, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows)) throw new Error(`Invalid Claude hook event: ${event}`)
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !Array.isArray((row as { hooks?: unknown }).hooks)) throw new Error(`Invalid Claude hook group: ${event}`)
        const group = row as { hooks: unknown[] }
        const resolvedHooks: Record<string, unknown>[] = []
        for (const item of group.hooks) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid Claude hook: ${event}`)
          const hook = item as { type?: unknown; command?: unknown }
          if (hook.type !== 'command' || typeof hook.command !== 'string') throw new Error(`Unsupported Claude hook type in ${source}`)
          const command = pluginRoot ? hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : hook.command
          const argv = literalArgv(command)
          const executable = executablePath(argv[0]!, cwd, input.pathEnv)
          const kind = basename(executable)
          if (['env', 'npx', 'pnpx', 'bunx', 'uvx', 'yarn', 'npm'].includes(kind)) throw new Error(`Dynamic Claude hook launcher needs separate review: ${source}`)
          if (/^(?:python\d*(?:\.\d+)?|node|bash|sh|zsh|ruby|perl)$/.test(kind)) {
            const script = argv[1]
            if (!script || script.startsWith('-') || !existsSync(isAbsolute(script) ? script : resolve(cwd, script))) {
              throw new Error(`Claude hook interpreter needs a pinned script: ${source}`)
            }
          }
          const executableBytes = readSource(executable)
          const executableHash = sha(executableBytes)
          pinShebang(executable, executableBytes, cwd, input.pathEnv, digest)
          const referencedFiles: { path: string; hash: string }[] = []
          const resolvedArgs: string[] = []
          for (const arg of argv.slice(1)) {
            if (['-c', '-e', '-m', '--eval', '--require'].includes(arg)) throw new Error(`Dynamic Claude hook loader needs separate review: ${source}`)
            const candidate = isAbsolute(arg) ? arg : resolve(cwd, arg)
            if (existsSync(candidate)) {
              const real = realpathSync(candidate)
              const bytes = readSource(real)
              const hash = sha(bytes)
              digest.update(real).update(hash)
              pinShebang(real, bytes, cwd, input.pathEnv, digest)
              referencedFiles.push({ path: real, hash })
              resolvedArgs.push(real)
            } else if (/\.(?:py|sh|js|cjs|mjs|ts)$/.test(arg)) throw new Error(`Claude hook script is unavailable: ${arg}`)
            else resolvedArgs.push(arg)
          }
          digest.update(executable).update(executableHash).update(JSON.stringify(resolvedArgs))
          review.push({ event, source, executable, executableHash, referencedFiles })
          resolvedHooks.push({ ...hook, command: [executable, ...resolvedArgs].map(shellQuote).join(' ') })
        }
        ;(hooks[event] ??= []).push({ ...row, hooks: resolvedHooks })
      }
    }
  }
  for (const file of [join(root, 'settings.json'), join(root, 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]) {
    if (!existsSync(file)) continue
    const settings = readObject(file)
    add(file, settings.hooks)
    if (settings.enabledPlugins !== undefined) {
      if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object' || Array.isArray(settings.enabledPlugins)) throw new Error(`Invalid enabled plugins: ${file}`)
      for (const [id, enabled] of Object.entries(settings.enabledPlugins)) {
        if (typeof enabled !== 'boolean') throw new Error(`Invalid plugin choice: ${id}`)
        plugins.set(id, enabled)
      }
    }
  }
  if ([...plugins.values()].some(Boolean)) {
    const registryFile = join(root, 'plugins', 'installed_plugins.json')
    if (!existsSync(registryFile)) throw new Error('Enabled Claude plugins have no installed-source registry')
    const registry = readObject(registryFile).plugins
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid Claude plugin registry')
    for (const [id, enabled] of plugins) {
      if (!enabled) continue
      const rows = (registry as Record<string, unknown>)[id]
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new Error(`Enabled Claude plugin source is unresolved: ${id}`)
      const path = (rows[0] as { installPath?: unknown }).installPath
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Invalid Claude plugin source: ${id}`)
      const pluginRoot = realpathSync(path)
      if (!statSync(pluginRoot).isDirectory()) throw new Error(`Invalid Claude plugin folder: ${id}`)
      const manifestFile = join(pluginRoot, '.claude-plugin', 'plugin.json')
      if (!within(pluginRoot, realpathSync(manifestFile))) throw new Error(`Claude plugin manifest leaves its installed folder: ${id}`)
      const manifest = readObject(manifestFile)
      if (manifest.hooks !== undefined && typeof manifest.hooks !== 'string') throw new Error(`Unsupported Claude plugin hook declaration: ${id}`)
      digest.update(id).update(pluginRoot).update(sha(readSource(manifestFile)))
      const hookFile = typeof manifest.hooks === 'string' ? resolve(pluginRoot, manifest.hooks) : join(pluginRoot, 'hooks', 'hooks.json')
      if (!within(pluginRoot, hookFile) || (existsSync(hookFile) && !within(pluginRoot, realpathSync(hookFile)))) {
        throw new Error(`Claude plugin hook source leaves its installed folder: ${id}`)
      }
      if (existsSync(hookFile)) add(hookFile, readObject(hookFile).hooks, pluginRoot)
      else if (manifest.hooks !== undefined) throw new Error(`Claude plugin hook file is unavailable: ${id}`)
    }
  }
  return { revision: digest.digest('hex'), settings: { hooks }, review }
}
