import { createHash } from 'node:crypto'
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { accessSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'

type Server = Readonly<Record<string, unknown>>
export interface McpSourceSnapshot {
  readonly revision: string
  readonly servers: Readonly<Record<string, Server>>
  readonly review: readonly { name: string; source: string; executable?: string; executableHash?: string; url?: string }[]
}

function sha(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }

function fileBytes(path: string): Buffer {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Review the linked MCP source separately: ${path}`)
  if (!statSync(path).isFile()) throw new Error(`MCP source is not a file: ${path}`)
  return readFileSync(path)
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
 * Only explicit user/project MCP files are imported. Strict mode prevents the CLI from
 * discovering any other MCP source. The revision binds file bytes, executable bytes,
 * referenced script bytes and the selected working folder; approve it before spawn.
 */
export function snapshotMcpSources(input: { readonly home: string; readonly cwd: string; readonly pathEnv: string; readonly profileDir?: string }): McpSourceSnapshot {
  const files = [input.profileDir ? join(input.profileDir, '.claude.json') : join(input.home, '.claude.json'), join(input.cwd, '.mcp.json')]
  const digest = createHash('sha256')
  digest.update(resolve(input.cwd)).update(input.profileDir ? resolve(input.profileDir) : resolve(input.home))
  const servers: Record<string, Server> = {}
  const review: { name: string; source: string; executable?: string; executableHash?: string; url?: string }[] = []
  for (const file of files) {
    if (!existsSync(file)) continue
    const bytes = fileBytes(file)
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid MCP source: ${file}`)
    const definitions = (parsed as { mcpServers?: unknown }).mcpServers
    if (definitions === undefined) continue
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error(`Invalid MCP servers: ${file}`)
    // .claude.json contains changing CLI metadata unrelated to MCP definitions.
    // Bind the selected definitions, rather than invalidating approval on every CLI write.
    digest.update(file).update(JSON.stringify(definitions))
    for (const [name, raw] of Object.entries(definitions)) {
      if (name.toLowerCase() === 'cockpit' || Object.hasOwn(servers, name)) throw new Error(`Reserved or duplicate MCP server name: ${name}`)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid MCP server: ${name}`)
      const server = raw as Server
      if (typeof server.command === 'string') {
        const command = executablePath(server.command, input.cwd, input.pathEnv)
        const executableHash = sha(fileBytes(command))
        digest.update(command).update(executableHash)
        if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string')) throw new Error(`Invalid MCP arguments: ${name}`)
        // Package-manager launchers can download new code under an unchanged config.
        if (['npx', 'pnpx', 'yarn', 'bunx', 'uvx'].includes(basename(server.command)) || /(?:npx|pnpx|yarn|bunx|uvx)(?:-cli)?\.(?:c?js|mjs)$/.test(basename(command))) {
          throw new Error(`Pin a local executable before approving MCP server ${name}`)
        }
        for (const arg of server.args as string[]) {
          const candidate = isAbsolute(arg) ? arg : resolve(input.cwd, arg)
          if (existsSync(candidate)) digest.update(realpathSync(candidate)).update(sha(fileBytes(candidate)))
        }
        review.push({ name, source: file, executable: command, executableHash })
        servers[name] = { ...server, command }
      } else if (typeof server.url === 'string') {
        const url = new URL(server.url)
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error(`Unsupported MCP endpoint for ${name}`)
        review.push({ name, source: file, url: `${url.origin}${url.pathname}` })
        servers[name] = server
      } else throw new Error(`Unsupported MCP server: ${name}`)
    }
  }
  return { revision: digest.digest('hex'), servers, review }
}
