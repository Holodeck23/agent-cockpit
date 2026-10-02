import type { ChildProcess } from 'node:child_process'

export const STOP_GRACE_MS = 1500

/**
 * Stops an agent process: stdin EOF first (lets it save its session), SIGTERM if
 * it is still running after `graceMs` (e.g. mid-turn), SIGKILL after twice that.
 * Resolves once the process has exited, so callers can quit without orphaning it.
 */
export function stopChild(child: ChildProcess, alive: () => boolean, graceMs: number = STOP_GRACE_MS): Promise<void> {
  if (!alive()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const term = setTimeout(() => child.kill('SIGTERM'), graceMs)
    const kill = setTimeout(() => child.kill('SIGKILL'), graceMs * 2)
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
