// A `@builtin` Claude plugin ships inside the CLI rather than a plugin folder, and which ones exist depends
// on the CLI version and the account's own state (an empty profile lists none, probed on 2.1.302). So its
// source is the CLI the conversation will run, asked in the context it will run in. Cockpit launches with
// `--setting-sources ''`, so what matters is only whether the plugin carries hooks that would be dropped.
// Anything not read as a clear answer is unknown, and unknown keeps hooks-on blocked.
import { execFileSync } from 'node:child_process'
import { resolveExecutable } from '../capabilities/resolve.ts'

export type BuiltinPluginReport =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly hooks: number }
  | { readonly state: 'unknown'; readonly reason: string }

export interface BuiltinPluginContext {
  readonly home: string
  readonly pathEnv: string
  /** A managed account's profile folder; the CLI default profile when absent. */
  readonly profileDir?: string
}

/** `claude plugin details <id>` output, as printed by 2.1.220 and 2.1.302. */
export function parseBuiltinPluginDetails(id: string, output: string): BuiltinPluginReport {
  if (output.includes(`Plugin "${id}" not found.`)) return { state: 'absent' }
  const hooks = /^\s*Hooks \((\d+)\)\s*$/m.exec(output)
  if (!/^\s*Component inventory\s*$/m.test(output) || !hooks) return { state: 'unknown', reason: 'Claude did not describe this built-in plugin' }
  return { state: 'present', hooks: Number(hooks[1]) }
}

const cache = new Map<string, BuiltinPluginReport>()

/** What the Claude CLI on this PATH says about one built-in plugin; cached per CLI file, profile and plugin. */
export function readBuiltinPlugin(id: string, context: BuiltinPluginContext): BuiltinPluginReport {
  const cli = resolveExecutable('claude', context.pathEnv)
  if (!cli) return { state: 'unknown', reason: 'Claude is not installed where Cockpit looks for it' }
  const key = JSON.stringify([cli.fingerprint, context.profileDir ?? null, id])
  const known = cache.get(key)
  if (known) return known
  let report: BuiltinPluginReport
  try {
    // Only what the CLI needs to find its own profile: no auth selectors from Cockpit's environment.
    const output = execFileSync(cli.realpath, ['plugin', 'details', id], {
      env: { HOME: context.home, PATH: context.pathEnv, ...(context.profileDir ? { CLAUDE_CONFIG_DIR: context.profileDir } : {}) },
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    report = parseBuiltinPluginDetails(id, output)
  } catch (error) {
    // "not found" exits 1 with its message on stdout (2.1.220). A failed run can only ever mean absent.
    const stdout = (error as { stdout?: unknown }).stdout
    const parsed = typeof stdout === 'string' ? parseBuiltinPluginDetails(id, stdout) : undefined
    report = parsed?.state === 'absent' ? parsed : { state: 'unknown', reason: 'Claude could not describe this built-in plugin' }
  }
  // A failed read is not remembered: the next review asks again.
  if (report.state !== 'unknown') cache.set(key, report)
  return report
}
