import type { ChildProcess } from 'node:child_process'

export const STOP_GRACE_MS = 1500

/**
 * Agents are spawned as their own process group (`AGENT_SPAWN`), so a CLI that has to be
 * terminated takes the shell commands it started with it instead of leaving them orphaned.
 * An agent that exits on EOF is left to tidy up after itself.
 */
export const AGENT_SPAWN = { detached: true } as const

export function signalAgent(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try { process.kill(-child.pid, signal); return } catch { /* not a group leader, or already gone */ }
  }
  child.kill(signal)
}

/**
 * Stops an agent process: stdin EOF first (lets it save its session), SIGTERM if
 * it is still running after `graceMs` (e.g. mid-turn), SIGKILL after twice that.
 * Resolves once the process has exited, so callers can quit without orphaning it.
 */
export function stopChild(child: ChildProcess, alive: () => boolean, graceMs: number = STOP_GRACE_MS): Promise<void> {
  if (!alive()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const term = setTimeout(() => signalAgent(child, 'SIGTERM'), graceMs)
    const kill = setTimeout(() => signalAgent(child, 'SIGKILL'), graceMs * 2)
    const finished = (): void => {
      clearTimeout(term)
      clearTimeout(kill)
      child.off('exit', finished)
      child.off('close', finished)
      resolve()
    }
    child.once('exit', finished)
    // Failed spawns emit close without exit, including a shutdown requested before error arrives.
    child.once('close', finished)
    child.stdin?.end()
  })
}
