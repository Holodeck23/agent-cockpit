import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// An app launched from Finder or the Dock gets launchd's PATH (/usr/bin:/bin:...),
// not the one from the user's shell profile, so `claude` and `codex` would not be
// found. Read macOS's system path list directly, then merge common user-level
// install folders. Do not start the user's interactive shell or source .zshrc.

/** Where supported CLIs and their runtimes are commonly installed. */
export function fallbackDirs(home: string = homedir()): string[] {
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.bun/bin'),
    join(home, '.volta/bin'), join(home, '.cargo/bin'), join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'), join(home, 'Library/pnpm'),
  ]
}

/** Pulls PATH from `/usr/libexec/path_helper -s` without evaluating its shell code. */
export function extractPathHelper(output: string): string | undefined {
  const match = /(?:^|\n)PATH="([^"]*)";\s*export PATH;/.exec(output)
  const path = match?.[1]?.trim()
  return path && path.length > 0 ? path : undefined
}

/** Shell entries first (the user's own order wins), then any current ones not already present. */
export function mergePath(current: string | undefined, preferred: readonly string[]): string {
  const entries = [...preferred, ...(current ?? '').split(':')].filter((entry) => entry.length > 0)
  return [...new Set(entries)].join(':')
}

export function systemPath(pathHelper = '/usr/libexec/path_helper', timeoutMs = 2000): string | undefined {
  try {
    const output = execFileSync(pathHelper, ['-s'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return extractPathHelper(output)
  } catch {
    return undefined
  }
}

/**
 * COCKPIT_AGENT_PATH names folders searched before everything else, for agent CLIs
 * installed somewhere unusual and for proofs that substitute a recorded stand-in.
 */
export function agentPathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.COCKPIT_AGENT_PATH ?? '').split(':').filter((entry) => entry.length > 0)
}

/** Returns the PATH the app should use, without executing user-controlled shell startup files. */
export function resolveAppPath(
  env: NodeJS.ProcessEnv = process.env,
  readSystemPath: () => string | undefined = () => systemPath(),
): { path: string; source: 'system' | 'fallback' } {
  const first = agentPathDirs(env)
  const common = fallbackDirs(env.HOME ?? homedir())
  const fromSystem = readSystemPath()
  const preferred = [...first, ...common, ...(fromSystem ?? '').split(':')]
  return { path: mergePath(env.PATH, preferred), source: fromSystem ? 'system' : 'fallback' }
}
