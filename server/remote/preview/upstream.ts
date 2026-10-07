import { execFile } from 'node:child_process'
import type { ProcessInfo } from '../../processes/runner.ts'

// Where a phone preview forwards to (W11.1, SEC-05): only the dev server URL the registered
// process itself printed, only on this Mac's loopback, and only while the listener on that port
// belongs to the process group Cockpit started. A different program on the same port (the old
// server died, something else took the port) is never reached.

export interface UpstreamTarget {
  /** Hostname to connect to: localhost, 127.0.0.1 or ::1. */
  readonly hostname: string
  readonly port: number
  /** Host header value the dev server expects, e.g. localhost:5173. */
  readonly host: string
  /** The run being previewed. */
  readonly generation: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The loopback http target of a process's printed URL, or undefined for anything else. */
export function loopbackTarget(url: string | undefined): { hostname: string; port: number; host: string } | undefined {
  if (!url) return undefined
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== 'http:' || !LOOPBACK.has(parsed.hostname) || parsed.username || parsed.password) return undefined
  const port = Number(parsed.port || 80)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { hostname: parsed.hostname === '[::1]' ? '::1' : parsed.hostname, port, host: parsed.host }
}

/** The process groups of the programs listening on a TCP port (lsof + ps). */
export type ListenerGroups = (port: number) => Promise<number[]>

const run = (file: string, args: readonly string[]): Promise<string> => new Promise((resolve) => {
  execFile(file, [...args], { timeout: 3000 }, (error, stdout) => resolve(error ? '' : stdout))
})

export const systemListenerGroups: ListenerGroups = async (port) => {
  const pids = (await run('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).split('\n').map(Number).filter((n) => n > 0)
  if (pids.length === 0) return []
  const groups = (await run('/bin/ps', ['-o', 'pgid=', '-p', pids.join(',')])).split('\n').map((line) => Number(line.trim())).filter((n) => n > 0)
  return [...new Set(groups)]
}

/**
 * Resolves the target for a process, checking at most once a second per port: every request asks,
 * and a dev server's assets arrive in bursts.
 */
export function createUpstreamResolver(listenerGroups: ListenerGroups = systemListenerGroups, now = Date.now) {
  const cache = new Map<number, { at: number; groups: Promise<number[]> }>()
  const groupsOn = (port: number): Promise<number[]> => {
    const hit = cache.get(port)
    if (hit && now() - hit.at < 1000) return hit.groups
    const groups = listenerGroups(port).catch(() => [])
    cache.set(port, { at: now(), groups })
    return groups
  }
  return {
    async resolve(process: ProcessInfo | undefined): Promise<UpstreamTarget | undefined> {
      if (!process || process.status !== 'running' || !process.pid) return undefined
      const target = loopbackTarget(process.url)
      if (!target) return undefined
      // Cockpit starts each process as its own group, so its group id is its pid.
      return (await groupsOn(target.port)).includes(process.pid) ? { ...target, generation: process.id } : undefined
    },
    /** Forget what was seen, e.g. after a process stopped. */
    forget(): void { cache.clear() },
  }
}
export type UpstreamResolver = ReturnType<typeof createUpstreamResolver>
