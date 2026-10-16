import { createHash } from 'node:crypto'
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { accessSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'

type Server = Readonly<Record<string, unknown>>
export interface McpSourceSnapshot {
  readonly revision: string
  readonly servers: Readonly<Record<string, Server>>
  readonly review: readonly { name: string; source: string; executable?: string; executableHash?: string;
    referencedFiles?: readonly { path: string; hash: string }[]; url?: string }[]
  /** Entries omitted from the private config; approval acknowledges this degraded selection. */
  readonly unavailable: readonly { name: string; source: string; reason: string }[]
}

function sha(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }

function pinShebang(path: string, bytes: Buffer, digest: ReturnType<typeof createHash>, cwd: string, pathEnv: string): void {
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return
  const line = bytes.toString('utf8', 2, Math.min(bytes.length, 512)).split('\n', 1)[0]?.trim() ?? ''
  const command = line.split(/\s+/, 1)[0]
  if (!command || basename(command) === 'env') throw new Error(`MCP shebang has an unpinned runtime: ${path}`)
  const runtime = executablePath(command, cwd, pathEnv)
  const runtimeBytes = fileBytes(runtime)
  if (runtimeBytes[0] === 0x23 && runtimeBytes[1] === 0x21) throw new Error(`MCP shebang has a chained runtime: ${path}`)
  digest.update(runtime).update(sha(runtimeBytes))
}

function fileBytes(path: string): Buffer {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Review the linked MCP source separately: ${path}`)
  if (!statSync(path).isFile()) throw new Error(`MCP source is not a file: ${path}`)
  return readFileSync(path)
}

function objectFromFile(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fileBytes(path).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid MCP source: ${path}`)
  return parsed as Record<string, unknown>
}

function within(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

function substitutePluginRoot(value: unknown, root: string): unknown {
  if (typeof value === 'string') return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
  if (Array.isArray(value)) return value.map((item) => substitutePluginRoot(item, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitutePluginRoot(item, root)]))
  return value
}

function executablePath(command: string, cwd: string, pathEnv: string): string {
  const candidates = command.includes('/') ? [resolve(cwd, command)] : pathEnv.split(delimiter).map((dir) => resolve(cwd, dir || '.', command))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      if (statSync(real).isFile()) return real
    } catch { /* Keep looking. */ }
  }
  throw new Error(`MCP executable is unavailable: ${command}`)
}

/**
 * Only explicit user/project and installed enabled-plugin MCP files are imported. Strict mode prevents the CLI from
 * discovering any other MCP source. The revision binds file bytes, executable bytes,
 * referenced script bytes and the selected working folder; approve it before spawn.
 */
export function snapshotMcpSources(input: { readonly home: string; readonly cwd: string; readonly pathEnv: string; readonly profileDir?: string;
  readonly accountId?: string; readonly accountGeneration?: number }): McpSourceSnapshot {
  const files = [input.profileDir ? join(input.profileDir, '.claude.json') : join(input.home, '.claude.json'), join(input.cwd, '.mcp.json')]
  const digest = createHash('sha256')
  digest.update(realpathSync(input.cwd)).update(input.profileDir ? realpathSync(input.profileDir) : realpathSync(input.home))
  digest.update(input.accountId ?? 'default-claude').update(String(input.accountGeneration ?? 1))
  const servers: Record<string, Server> = Object.create(null) as Record<string, Server>
  const review: McpSourceSnapshot['review'][number][] = []
  const unavailable: McpSourceSnapshot['unavailable'][number][] = []
  const seen = new Set<string>()
  const add = (file: string, definitions: unknown, pluginRoot?: string): void => {
    if (definitions === undefined) return
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error(`Invalid MCP servers: ${file}`)
    // .claude.json contains changing CLI metadata unrelated to MCP definitions.
    // Bind the selected definitions, rather than invalidating approval on every CLI write.
    digest.update(file).update(JSON.stringify(definitions))
    for (const [name, raw] of Object.entries(definitions)) {
      if (name.toLowerCase() === 'cockpit' || seen.has(name)) throw new Error(`Reserved or duplicate MCP server name: ${name}`)
      seen.add(name)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid MCP server: ${name}`)
      const server = (pluginRoot ? substitutePluginRoot(raw, pluginRoot) : raw) as Server
      if (typeof server.command === 'string') {
        if (['npx', 'pnpx', 'npm', 'yarn', 'bunx', 'uvx'].includes(basename(server.command))) {
          unavailable.push({ name, source: file, reason: 'Pin a local executable before this connector can run' })
          continue
        }
        const command = executablePath(server.command, pluginRoot ?? input.cwd, input.pathEnv)
        const executableBytes = fileBytes(command)
        const executableHash = sha(executableBytes)
        digest.update(command).update(executableHash)
        pinShebang(command, executableBytes, digest, pluginRoot ?? input.cwd, input.pathEnv)
        if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string')) throw new Error(`Invalid MCP arguments: ${name}`)
        // Package-manager launchers can download new code under an unchanged config.
        if (/(?:npx|pnpx|npm|yarn|bunx|uvx)(?:-cli)?\.(?:c?js|mjs)$/.test(basename(command))) {
          unavailable.push({ name, source: file, reason: 'Pin a local executable before this connector can run' })
          continue
        }
        if (/^(?:node|python\d*(?:\.\d+)?|bash|sh|zsh|ruby|perl)$/.test(basename(command))) {
          const script = (server.args as string[])[0]
          if (!script || script.startsWith('-') || !existsSync(isAbsolute(script) ? script : resolve(pluginRoot ?? input.cwd, script))) {
            throw new Error(`MCP interpreter needs a pinned script: ${name}`)
          }
        }
        const resolvedArgs: string[] = []
        const referencedFiles: { path: string; hash: string }[] = []
        for (const arg of server.args as string[]) {
          if (/^(?:-c|-e|-m|-p|-r|--eval|--print|--require|--import|--loader|--experimental-loader)(?:=|$)/.test(arg)) {
            throw new Error(`Dynamic MCP loader needs separate review: ${name}`)
          }
          const candidate = isAbsolute(arg) ? arg : resolve(pluginRoot ?? input.cwd, arg)
          if (existsSync(candidate)) {
            const real = realpathSync(candidate)
            const bytes = fileBytes(real)
            const hash = sha(bytes)
            digest.update(real).update(hash)
            pinShebang(real, bytes, digest, pluginRoot ?? input.cwd, input.pathEnv)
            referencedFiles.push({ path: real, hash })
            resolvedArgs.push(real)
          }
          else if (/\.(?:py|sh|js|cjs|mjs|ts)$/.test(arg)) throw new Error(`MCP script is unavailable: ${arg}`)
          else resolvedArgs.push(arg)
        }
        review.push({ name, source: file, executable: command, executableHash, referencedFiles })
        servers[name] = { ...server, command, args: resolvedArgs }
      } else if (typeof server.url === 'string') {
        const url = new URL(server.url)
        if (url.username || url.password) throw new Error(`MCP endpoint credentials need a private header: ${name}`)
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error(`Unsupported MCP endpoint for ${name}`)
        review.push({ name, source: file, url: `${url.origin}${url.pathname}` })
        servers[name] = server
      } else throw new Error(`Unsupported MCP server: ${name}`)
    }
  }
  for (const file of files) {
    if (!existsSync(file)) continue
    add(file, objectFromFile(file).mcpServers)
  }
  const profile = input.profileDir ?? join(input.home, '.claude')
  const enabled = new Map<string, boolean>()
  for (const file of [join(profile, 'settings.json'), join(profile, 'settings.local.json'),
    join(input.cwd, '.claude', 'settings.json'), join(input.cwd, '.claude', 'settings.local.json')]) {
    if (!existsSync(file)) continue
    const choices = objectFromFile(file).enabledPlugins
    if (choices === undefined) continue
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new Error(`Invalid enabled plugins: ${file}`)
    for (const [id, state] of Object.entries(choices)) {
      if (typeof state !== 'boolean') throw new Error(`Invalid plugin choice: ${id}`)
      enabled.set(id, state)
    }
  }
  if ([...enabled.values()].some(Boolean)) {
    const registryFile = join(profile, 'plugins', 'installed_plugins.json')
    const registry = existsSync(registryFile) ? objectFromFile(registryFile).plugins : {}
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid Claude plugin registry')
    for (const [id, state] of enabled) {
      if (!state) continue
      const entries = (registry as Record<string, unknown>)[id]
      if (!Array.isArray(entries) || entries.length === 0) {
        digest.update(id).update('unavailable-plugin-source')
        unavailable.push({ name: id, source: registryFile, reason: 'Enabled plugin has no installed source; it is omitted' })
        continue
      }
      if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object') throw new Error(`Enabled Claude plugin source is ambiguous: ${id}`)
      const path = (entries[0] as { installPath?: unknown }).installPath
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Invalid Claude plugin source: ${id}`)
      const root = realpathSync(path)
      if (!statSync(root).isDirectory()) throw new Error(`Invalid Claude plugin folder: ${id}`)
      const manifestFile = join(root, '.claude-plugin', 'plugin.json')
      if (!within(root, realpathSync(manifestFile))) throw new Error(`Claude plugin manifest leaves its installed folder: ${id}`)
      const manifest = objectFromFile(manifestFile)
      digest.update(id).update(root).update(sha(fileBytes(manifestFile)))
      const declared = manifest.mcpServers
      if (declared !== undefined && typeof declared !== 'string' && (typeof declared !== 'object' || !declared || Array.isArray(declared))) {
        throw new Error(`Unsupported Claude plugin MCP declaration: ${id}`)
      }
      const pluginFile = typeof declared === 'string' ? resolve(root, declared) : join(root, '.mcp.json')
      if (!within(root, pluginFile) || (existsSync(pluginFile) && !within(root, realpathSync(pluginFile)))) {
        throw new Error(`Claude plugin MCP source leaves its installed folder: ${id}`)
      }
      if (typeof declared === 'object' && declared) add(manifestFile, declared, root)
      else if (existsSync(pluginFile)) {
        const config = objectFromFile(pluginFile)
        add(pluginFile, config.mcpServers ?? config, root)
      } else if (declared !== undefined) throw new Error(`Claude plugin MCP source is unavailable: ${id}`)
    }
  }
  return { revision: digest.digest('hex'), servers, review, unavailable }
}
