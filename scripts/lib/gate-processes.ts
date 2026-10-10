export interface GateProcess {
  pid: number
  ppid: number
  started: string
  command: string
}

export interface GateProcessLeak {
  pid: number
  command: string
}

export const processIdentity = (process: Pick<GateProcess, 'pid' | 'started'>): string => `${process.pid}:${process.started}`

export function parseProcessTable(text: string): GateProcess[] {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(.*)$/.exec(line)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3]!, command: match[4]!.trim() }]
  })
}

/** Captures the suite root and every descendant visible in this snapshot, regardless of process group. */
export function descendantsOf(processes: readonly GateProcess[], rootPid: number): GateProcess[] {
  const owned = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (!owned.has(process.pid) && owned.has(process.ppid)) {
        owned.add(process.pid)
        changed = true
      }
    }
  }
  return processes.filter((process) => owned.has(process.pid))
}

/** Matches PID plus start time so a recycled PID cannot be mistaken for a surviving proof process. */
export function survivingOwnedProcesses(
  current: readonly GateProcess[],
  observed: ReadonlyMap<string, GateProcess>,
  gateAncestry: ReadonlySet<number>,
): GateProcessLeak[] {
  const currentByIdentity = new Map(current.map((process) => [processIdentity(process), process]))
  return [...observed.keys()].flatMap((identity) => {
    const process = currentByIdentity.get(identity)
    if (!process || gateAncestry.has(process.pid)) return []
    return [{ pid: process.pid, command: process.command.slice(0, 240) }]
  })
}

export function gatePassesProcessCleanup(basePassed: boolean, leaks: readonly unknown[]): boolean {
  return basePassed && leaks.length === 0
}
