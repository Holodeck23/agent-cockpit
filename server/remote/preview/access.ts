import { randomBytes } from 'node:crypto'
import type { CookieJar } from './jar.ts'

// Who may see a phone preview (W11.2), held in memory only. A paired phone asks the control origin
// for a ticket for one service; the ticket is random, one-use, valid for 30 seconds and bound to
// the phone, its Tailscale login, the service, the process generation and the preview origin. The
// preview origin's bootstrap consumes it on first sight (valid or not) and opens a session bound
// to the same things. Sessions expire after 30 idle minutes and die with their generation.
//
// App cookies live in a jar per phone and service, so opening the same app again keeps its sign-in
// (the Pixel found a jar per session logged people out). Jars are cleared with the phone's access.

export const TICKET_MS = 30_000
export const SESSION_IDLE_MS = 30 * 60_000

export interface Grant {
  readonly deviceId: string
  readonly login: string
  readonly serviceId: string
  /** The process id of the run being previewed; a restart is a new generation. */
  readonly generation: string
  /** Exact https origin of the service's listener. */
  readonly origin: string
}

/** Something that can be closed when access ends: an open WebSocket or streaming response. */
export interface Closable { destroy(): void }

export interface PreviewSession extends Grant {
  readonly id: string
  /** The jar for this phone and service, shared by its sessions. */
  readonly jar: CookieJar
}

export type TicketRefusal = 'unknown' | 'expired' | 'mismatch'

export interface PreviewAccess {
  issue(grant: Grant): string
  /** Consumes the ticket whatever happens; opens a session only when it matches `at`. */
  redeem(ticket: string, at: Omit<Grant, 'generation'> & { readonly generation: string | undefined }): { session: PreviewSession } | { refused: TicketRefusal }
  /** The session behind a preview cookie, if it is still valid for this request. */
  session(id: string | undefined, at: { serviceId: string; login: string; generation: string | undefined }): PreviewSession | undefined
  /** Ties an open socket or stream to a session, so ending the session closes it. */
  hold(sessionId: string, closable: Closable): () => void
  /** Ends sessions (and closes what they hold) for one phone, one service, or everything. */
  revoke(scope: { deviceId: string } | { serviceId: string } | 'all'): number
  /** Ends a service's sessions for any generation other than `generation`. */
  retireGenerations(serviceId: string, generation: string | undefined): number
  sessionCount(): number
}

const token = (): string => randomBytes(32).toString('base64url')

export function createPreviewAccess(now = Date.now): PreviewAccess {
  const tickets = new Map<string, Grant & { expires: number }>()
  const sessions = new Map<string, PreviewSession & { seen: number; held: Set<Closable> }>()
  const jars = new Map<string, CookieJar>()
  const jarFor = (deviceId: string, serviceId: string): CookieJar => {
    const key = `${deviceId}\n${serviceId}`
    const existing = jars.get(key)
    if (existing) return existing
    const jar: CookieJar = new Map()
    jars.set(key, jar)
    return jar
  }
  const end = (id: string): void => {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    for (const closable of s.held) closable.destroy()
  }
  const prune = (): void => {
    const t = now()
    for (const [key, ticket] of tickets) if (ticket.expires <= t) tickets.delete(key)
    for (const [id, s] of sessions) if (t - s.seen > SESSION_IDLE_MS) end(id)
  }

  return {
    issue(grant) {
      prune()
      const ticket = token()
      tickets.set(ticket, { ...grant, expires: now() + TICKET_MS })
      return ticket
    },
    redeem(ticket, at) {
      const found = tickets.get(ticket)
      tickets.delete(ticket)
      if (!found) return { refused: 'unknown' }
      if (found.expires <= now()) return { refused: 'expired' }
      if (at.generation === undefined || found.deviceId !== at.deviceId || found.login !== at.login || found.serviceId !== at.serviceId
        || found.generation !== at.generation || found.origin !== at.origin) return { refused: 'mismatch' }
      const session = { id: token(), deviceId: found.deviceId, login: found.login, serviceId: found.serviceId, generation: found.generation,
        origin: found.origin, jar: jarFor(found.deviceId, found.serviceId), seen: now(), held: new Set<Closable>() }
      sessions.set(session.id, session)
      return { session }
    },
    session(id, at) {
      if (!id) return undefined
      const s = sessions.get(id)
      if (!s) return undefined
      if (now() - s.seen > SESSION_IDLE_MS || at.generation === undefined || s.generation !== at.generation) { end(id); return undefined }
      if (s.serviceId !== at.serviceId || s.login !== at.login) return undefined
      s.seen = now()
      return s
    },
    hold(sessionId, closable) {
      const s = sessions.get(sessionId)
      if (!s) { closable.destroy(); return () => undefined }
      s.held.add(closable)
      return () => { s.held.delete(closable) }
    },
    revoke(scope) {
      const ids = [...sessions.values()].filter((s) => scope === 'all' || ('deviceId' in scope ? s.deviceId === scope.deviceId : s.serviceId === scope.serviceId)).map((s) => s.id)
      for (const id of ids) end(id)
      for (const [key, ticket] of tickets) if (scope === 'all' || ('deviceId' in scope ? ticket.deviceId === scope.deviceId : ticket.serviceId === scope.serviceId)) tickets.delete(key)
      for (const key of [...jars.keys()]) {
        const [deviceId, serviceId] = key.split('\n')
        if (scope === 'all' || ('deviceId' in scope ? deviceId === scope.deviceId : serviceId === scope.serviceId)) jars.delete(key)
      }
      return ids.length
    },
    retireGenerations(serviceId, generation) {
      const ids = [...sessions.values()].filter((s) => s.serviceId === serviceId && s.generation !== generation).map((s) => s.id)
      for (const id of ids) end(id)
      for (const [key, ticket] of tickets) if (ticket.serviceId === serviceId && ticket.generation !== generation) tickets.delete(key)
      return ids.length
    },
    sessionCount: () => sessions.size,
  }
}
