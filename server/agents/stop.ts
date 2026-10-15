import { execFileSync, type ChildProcess } from 'node:child_process'

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
 * Also tracks descendants present during shutdown, including ones that have created
 * a separate process group. A provider exit is not evidence that its hooks exited.
 * This is best-effort process cleanup, not a containment boundary: a hook can spawn
 * and detach another process after the last snapshot.
 */
export function stopChild(child: ChildProcess, alive: () => boolean, graceMs: number = STOP_GRACE_MS): Promise<void> {
  if (!alive()) return Promise.resolve()
  const descendants = new Map<number, string>()
  const capture = (): void => {
    const providerPid = child.pid
    if (!providerPid) return
    try {
      const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,stat='], { encoding: 'utf8', timeout: 2000 }).split('\n')
      const rows = lines.map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)).filter((row): row is RegExpExecArray => row !== null)
      const family = new Set([providerPid])
      let added = true
      while (added) {
        added = false
        for (const row of rows) {
          const pid = Number(row[1])
          if (!family.has(pid) && family.has(Number(row[2]))) { family.add(pid); added = true }
        }
      }
      for (const row of rows) {
        const pid = Number(row[1])
        if (pid === providerPid || !family.has(pid) || row[3]?.startsWith('Z') || descendants.has(pid)) continue
        const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
        if (started) descendants.set(pid, started)
      }
    } catch { /* The provider still receives group signals if process enumeration fails. */ }
  }
  const stillRunning = (pid: number, started: string): boolean => {
    try {
      const current = execFileSync('ps', ['-o', 'lstart=,stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
      return current.startsWith(started) && !current.slice(started.length).trim().startsWith('Z')
    } catch { return false }
  }
  const signalDescendants = (signal: NodeJS.Signals): void => {
    for (const [pid, started] of descendants) {
      if (!stillRunning(pid, started)) continue
      try { process.kill(pid, signal) } catch { /* Already exited. */ }
    }
  }
  capture()
  return new Promise<void>((resolve) => {
    let providerExited = false
    let done = false
    const settle = setInterval(() => {
      if (providerExited && [...descendants].every(([pid, started]) => !stillRunning(pid, started))) finished()
    }, 50)
    const term = setTimeout(() => {
      if (!providerExited) capture()
      signalAgent(child, 'SIGTERM')
      signalDescendants('SIGTERM')
    }, graceMs)
    const kill = setTimeout(() => {
      if (!providerExited) capture()
      signalAgent(child, 'SIGKILL')
      signalDescendants('SIGKILL')
    }, graceMs * 2)
    const deadline = setTimeout(() => finished(), graceMs * 2 + 500)
    const finished = (): void => {
      if (done) return
      done = true
      clearTimeout(term)
      clearTimeout(kill)
      clearTimeout(deadline)
      clearInterval(settle)
      child.off('exit', onExit)
      child.off('close', onExit)
      resolve()
    }
    const onExit = (): void => {
      providerExited = true
      if ([...descendants].every(([pid, started]) => !stillRunning(pid, started))) finished()
    }
    child.once('exit', onExit)
    // Failed spawns emit close without exit, including a shutdown requested before error arrives.
    child.once('close', onExit)
    child.stdin?.end()
  })
}
