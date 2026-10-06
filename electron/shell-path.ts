import { execFileSync } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

// An app launched from Finder or the Dock gets launchd's PATH (/usr/bin:/bin:...),
// not the one from the user's shell profile, so `claude` and `codex` would not be
// found. Ask the login shell for its PATH once at startup and merge it in.

const MARKER = '__COCKPIT_PATH__'

/** Where CLIs usually live, used only if the login shell can't be asked. */
export function fallbackDirs(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.bun/bin')]
}

/** Pulls the PATH out of shell output that may also contain profile banners. */
export function extractMarkedPath(output: string): string | undefined {
  const start = output.indexOf(MARKER)
  const end = output.indexOf(MARKER, start + MARKER.length)
  if (start === -1 || end === -1) return undefined
  const path = output.slice(start + MARKER.length, end).trim()
  return path.length > 0 ? path : undefined
}

/** Shell entries first (the user's own order wins), then any current ones not already present. */
export function mergePath(current: string | undefined, preferred: readonly string[]): string {
  const entries = [...preferred, ...(current ?? '').split(':')].filter((entry) => entry.length > 0)
  return [...new Set(entries)].join(':')
}

export function loginShellPath(shell: string, timeoutMs = 5000): string | undefined {
  try {
    const output = execFileSync(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return extractMarkedPath(output)
  } catch {
    return undefined
  }
}

function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL
  try {
    return userInfo().shell ?? '/bin/zsh'
  } catch {
    return '/bin/zsh'
  }
}

/**
 * COCKPIT_AGENT_PATH names folders searched before everything else, for agent CLIs
 * installed somewhere unusual and for proofs that substitute a recorded stand-in.
 */
export function agentPathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.COCKPIT_AGENT_PATH ?? '').split(':').filter((entry) => entry.length > 0)
}

/**
 * Returns the PATH the app should use, and whether it came from the login shell. ~/.local/bin is
 * always on it, after the shell's own entries: the official installers put CLIs there without
 * editing a shell profile when Cockpit installs them (G-LIFECYCLE), so the shell may not list it.
 */
export function resolveAppPath(
  env: NodeJS.ProcessEnv = process.env,
  shellPath: () => string | undefined = () => loginShellPath(defaultShell()),
  home: string = homedir(),
): { path: string; source: 'shell' | 'fallback' } {
  const first = agentPathDirs(env)
  const fromShell = shellPath()
  if (fromShell) return { path: mergePath(env.PATH, [...first, ...fromShell.split(':'), join(home, '.local/bin')]), source: 'shell' }
  return { path: mergePath(env.PATH, [...first, ...fallbackDirs()]), source: 'fallback' }
}
