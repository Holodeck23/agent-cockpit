import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { HttpError, parseBody, readJson, sendJson } from '../../http/json.ts'
import type { ProcessInfo, ProcessRunner } from '../../processes/runner.ts'
import { cookieValues } from '../guard.ts'
import { DEVICE_COOKIE } from '../service.ts'
import type { RemoteStore } from '../store.ts'
import type { Tailscale } from '../tailscale.ts'
import { createPreviewAccess, type PreviewAccess } from './access.ts'
import { BOOTSTRAP_PATH, createPreviewGateway, previewOrigin, type GatewayPolicy, type PreviewGateway } from './gateway.ts'
import { commandHash, createPreviewServiceStore, PREVIEW_HTTPS_PORTS, PreviewCapacityError, PreviewStoreError, slotPorts, type PreviewService } from './services.ts'
import { createUpstreamResolver, loopbackTarget, type ListenerGroups } from './upstream.ts'

// Phone previews in the running app (H5, W11): the paired phone asks the control origin for a
// one-use ticket for a running process, and opens the app on that service's own origin. The Mac
// decides which processes get an origin and runs the `tailscale serve` entry for it only when the
// person clicks; nothing here changes Tailscale on its own. Access ends with the phone, with phone
// access, with the run (stop, exit, restart) and with the project.

export type PreviewState = 'phone-off' | 'stopped' | 'no-local-url' | 'not-enabled'

export interface PreviewTicket {
  readonly origin: string
  readonly ticket: string
  /** Where the phone posts the ticket, and the window name it opens in. */
  readonly bootstrap: string
  readonly target: string
}

export interface ServeEntry {
  readonly httpsPort: number
  readonly listenPort: number
  /** The exact command shown before it is run, and its undo. */
  readonly command: string
  readonly undo: string
}

export interface PreviewView {
  readonly id: string
  readonly slot: number
  readonly name: string
  readonly projectPath: string
  readonly origin?: string
  readonly serve: ServeEntry
  /** Whether Tailscale serves this origin to Cockpit, nothing, or something else. */
  readonly tailscale: 'cockpit' | 'none' | 'other' | 'unknown'
  readonly other?: string
  /** Its listener is open, so a ticket can be issued. */
  readonly open: boolean
  readonly retired: boolean
  /** The running process it previews now, if any. */
  readonly processId?: string
}

export interface PreviewsStatus {
  readonly phoneAccess: boolean
  readonly limit: number
  readonly services: PreviewView[]
  /** Running processes with a local address that have no phone preview yet. */
  readonly candidates: { processId: string; name: string; projectPath: string; url: string }[]
  readonly error?: string
}

export interface PhonePreviewOptions {
  readonly root: string
  readonly remoteStore: RemoteStore
  readonly tailscale: Tailscale
  readonly processes: ProcessRunner
  /** The control origin's tailnet policy while phone access is running. */
  readonly policy: () => GatewayPolicy | undefined
  /** Tests: listener ports (0 = any free one) and who holds a port. */
  readonly listenPort?: (service: PreviewService) => number
  readonly listenerGroups?: ListenerGroups
  /** A proof build's shorter wait for a dev server's first byte. */
  readonly firstByteMs?: number
  readonly log?: (line: string) => void
}

const prepareBody = z.object({ processId: z.string().min(1).max(200) })

export function serveEntry(service: PreviewService, listenPort = slotPorts(service.slot).listenPort): ServeEntry {
  const { httpsPort } = slotPorts(service.slot)
  return { httpsPort, listenPort, command: `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${listenPort}`, undo: `tailscale serve --https=${httpsPort} off` }
}

/** Every origin a phone preview can have on this Mac, for the control page's form-action. */
export function previewOrigins(hostname: string): string[] {
  return Array.from({ length: PREVIEW_HTTPS_PORTS.count }, (_, i) => `https://${hostname}:${PREVIEW_HTTPS_PORTS.first + i}`)
}

export function createPhonePreviews(options: PhonePreviewOptions) {
  const { remoteStore, tailscale, processes } = options
  const config = remoteStore.read()
  const services = createPreviewServiceStore(options.root, { httpsPorts: [config.httpsPort], listenPorts: [config.port] })
  const access: PreviewAccess = createPreviewAccess()
  const resolver = createUpstreamResolver(options.listenerGroups)

  const identityOf = (p: ProcessInfo) => ({ projectPath: p.projectPath, name: p.name, command: p.command })
  /** The newest running process of this service, if any. */
  const liveProcess = (service: PreviewService): ProcessInfo | undefined => (service.retiredAt ? undefined
    : processes.list(service.projectPath).find((p) => p.status === 'running' && p.name === service.name && commandHash(p.command) === service.commandHash))

  const gateway: PreviewGateway = createPreviewGateway({
    access,
    policy: options.policy,
    // More than one device cookie is ambiguous (another origin on this host can set one): no phone.
    device: (req: IncomingMessage, login: string) => {
      const values = cookieValues(req, DEVICE_COOKIE)
      return values.length === 1 ? remoteStore.deviceFor(values[0], login)?.id : undefined
    },
    upstream: (service) => resolver.resolve(liveProcess(service)),
    ...(options.listenPort ? { listenPort: options.listenPort } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.firstByteMs ? { firstByteMs: options.firstByteMs } : {}),
  })
  /** The listener port each open service actually got (the slot's, except in tests). */
  const bound = new Map<string, number>()
  // A test override of 0 means "any free port", known only once bound.
  const configuredPort = (service: PreviewService): number => options.listenPort?.(service) || slotPorts(service.slot).listenPort
  const listenPortOf = (service: PreviewService): number => bound.get(service.id) ?? configuredPort(service)

  // A run that stops, exits or is restarted takes its preview sessions (and their open sockets)
  // with it; a restart is a new process id, so it needs a fresh ticket (W11.2, SEC-06).
  const unsubscribe = processes.subscribe((info) => {
    if (info.status === 'running') return
    const service = services.find(identityOf(info))
    if (!service) return
    resolver.forget()
    access.retireGenerations(service.id, liveProcess(service)?.id)
  })

  async function open(service: PreviewService): Promise<number> {
    const port = await gateway.open(service)
    bound.set(service.id, port)
    return port
  }
  async function close(serviceId: string): Promise<void> {
    await gateway.close(serviceId)
    bound.delete(serviceId)
  }

  async function ticket(at: { deviceId: string; login: string; processId: string }): Promise<PreviewTicket | { state: PreviewState; error: string }> {
    const policy = options.policy()
    if (!policy) return { state: 'phone-off', error: 'Phone access is off on your Mac.' }
    const process = processes.get(at.processId)
    if (!process || process.status !== 'running') return { state: 'stopped', error: 'This app is not running. Start it from Cockpit on your Mac.' }
    if (!loopbackTarget(process.url)) return { state: 'no-local-url', error: 'This process has not shown a local web address, so there is nothing to open.' }
    const service = services.find(identityOf(process))
    if (!service || !gateway.openIds().includes(service.id)) {
      return { state: 'not-enabled', error: 'Phone preview is not turned on for this app. Turn it on in Phone access on your Mac.' }
    }
    const target = await resolver.resolve(process)
    if (!target) return { state: 'stopped', error: 'The app is not answering on its address yet, or another program holds its port.' }
    const origin = previewOrigin(policy.hostname, service)
    return { origin, ticket: access.issue({ deviceId: at.deviceId, login: at.login, serviceId: service.id, generation: target.generation, origin }),
      bootstrap: `${origin}${BOOTSTRAP_PATH}`, target: `preview-${service.slot}` }
  }

  async function tailscaleState(hostname: string | undefined, service: PreviewService): Promise<Pick<PreviewView, 'tailscale' | 'other'>> {
    if (!hostname) return { tailscale: 'unknown' }
    try {
      const target = await tailscale.serveTarget(hostname, slotPorts(service.slot).httpsPort)
      if (!target) return { tailscale: 'none' }
      return target === `http://127.0.0.1:${listenPortOf(service)}` ? { tailscale: 'cockpit' } : { tailscale: 'other', other: target }
    } catch { return { tailscale: 'unknown' } }
  }

  async function status(): Promise<PreviewsStatus> {
    const policy = options.policy()
    const list = services.list()
    const views = await Promise.all(list.map(async (service): Promise<PreviewView> => {
      const live = liveProcess(service)
      return {
        id: service.id, slot: service.slot, name: service.name, projectPath: service.projectPath,
        ...(policy ? { origin: previewOrigin(policy.hostname, service) } : {}),
        serve: serveEntry(service, listenPortOf(service)),
        ...(service.retiredAt ? { tailscale: 'unknown' as const } : await tailscaleState(policy?.hostname, service)),
        open: gateway.openIds().includes(service.id), retired: Boolean(service.retiredAt),
        ...(live ? { processId: live.id } : {}),
      }
    }))
    const candidates = processes.list().filter((p) => p.status === 'running' && p.url && loopbackTarget(p.url) && !services.find(identityOf(p)))
      .map((p) => ({ processId: p.id, name: p.name, projectPath: p.projectPath, url: p.url! }))
    return { phoneAccess: Boolean(policy), limit: PREVIEW_HTTPS_PORTS.count, services: views, candidates, ...(services.damaged ? { error: services.damaged } : {}) }
  }

  /** Gives a running process its phone origin. Changes nothing in Tailscale. */
  function prepare(processId: string): PreviewService {
    const process = processes.get(processId)
    if (!process || process.status !== 'running') throw new HttpError(409, 'Start the app first, then turn on its phone preview.')
    if (!loopbackTarget(process.url)) throw new HttpError(409, 'This process has not shown a local http address (localhost or 127.0.0.1), so a phone cannot open it.')
    try {
      return services.ensure(identityOf(process))
    } catch (error) {
      if (error instanceof PreviewCapacityError || error instanceof PreviewStoreError) throw new HttpError(409, error.message)
      throw error
    }
  }

  /** Runs the shown `tailscale serve` entry, after the person clicked it. Never takes over a port serving something else. */
  async function serve(serviceId: string): Promise<void> {
    const policy = options.policy()
    if (!policy) throw new HttpError(409, 'Turn on phone access first.')
    const service = services.get(serviceId)
    if (!service || service.retiredAt) throw new HttpError(404, 'Unknown phone preview')
    const { httpsPort } = slotPorts(service.slot)
    const wasOpen = gateway.openIds().includes(service.id)
    const port = await open(service)
    const ours = `http://127.0.0.1:${port}`
    try {
      const target = await tailscale.serveTarget(policy.hostname, httpsPort)
      if (target && target !== ours) throw new HttpError(409, `HTTPS ${httpsPort} on this Mac's Tailscale address already goes to ${target}. Cockpit leaves it alone.`)
      if (!target) await tailscale.serve(port, httpsPort)
    } catch (error) {
      if (!wasOpen) await close(service.id)
      throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error))
    }
  }

  /** Removes this preview's own `tailscale serve` entry (only if it is still Cockpit's) and closes its listener. */
  async function unserve(serviceId: string): Promise<void> {
    const service = services.get(serviceId)
    if (!service) throw new HttpError(404, 'Unknown phone preview')
    const { httpsPort } = slotPorts(service.slot)
    const hostname = options.policy()?.hostname ?? (await tailscale.self().catch(() => undefined))?.hostname
    try {
      if (hostname && (await tailscale.serveTarget(hostname, httpsPort)) === `http://127.0.0.1:${listenPortOf(service)}`) await tailscale.unserve(httpsPort)
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error))
    } finally {
      await close(service.id)
    }
  }

  /** Desktop routes under /api/phone/previews. */
  async function handleLocal(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const method = req.method ?? 'GET'
    if (parts.length === 3 && method === 'GET') return sendJson(res, 200, { data: await status() })
    if (parts.length === 3 && method === 'POST') {
      const service = prepare(parseBody(prepareBody, await readJson(req)).processId)
      return sendJson(res, 200, { data: { serviceId: service.id, status: await status() } })
    }
    if (parts.length === 5 && parts[4] === 'serve' && method === 'POST') { await serve(parts[3]!); return sendJson(res, 200, { data: await status() }) }
    if (parts.length === 5 && parts[4] === 'unserve' && method === 'POST') { await unserve(parts[3]!); return sendJson(res, 200, { data: await status() }) }
    throw new HttpError(404, 'Not found')
  }

  return {
    ticket,
    status,
    handleLocal,
    /** Phone access came on: reopen the listeners whose Serve entry is still Cockpit's. */
    async started(): Promise<void> {
      const policy = options.policy()
      if (!policy) return
      for (const service of services.list()) {
        if (service.retiredAt || gateway.openIds().includes(service.id)) continue
        const expected = `http://127.0.0.1:${configuredPort(service)}`
        const target = await tailscale.serveTarget(policy.hostname, slotPorts(service.slot).httpsPort).catch(() => undefined)
        if (target === expected) await open(service).catch((error: unknown) => options.log?.(`preview ${service.slot} not reopened: ${error instanceof Error ? error.message : String(error)}`))
      }
    },
    /**
     * The person turned phone access off: the Serve entries Cockpit added for previews go too, so
     * nothing it set up stays on the tailnet. Only an entry still pointing at its own listener is
     * removed; one changed to anything else is left. (Quit keeps them: that is `stopped`.)
     * Returns the HTTPS ports it could not remove.
     */
    async turnedOff(hostname: string): Promise<number[]> {
      const failed: number[] = []
      for (const service of services.list()) {
        const { httpsPort } = slotPorts(service.slot)
        try {
          if ((await tailscale.serveTarget(hostname, httpsPort)) === `http://127.0.0.1:${listenPortOf(service)}`) await tailscale.unserve(httpsPort)
        } catch {
          failed.push(httpsPort)
        }
      }
      return failed
    },
    /** Phone access went off (or Cockpit is closing): every preview listener, session and app cookie ends. Tailscale is left as it is. */
    async stopped(): Promise<void> {
      for (const id of gateway.openIds()) await close(id)
      access.revoke('all')
    },
    /** A phone was removed: its sessions, sockets and app cookies end. */
    deviceRevoked(deviceId: string): number { return access.revoke({ deviceId }) },
    /**
     * A project was removed: its previews end and are never offered again. Their origins stay
     * reserved (an open phone tab could otherwise script the next app given that origin) and their
     * Serve entries stay until the person removes them.
     */
    async retireProject(projectPath: string): Promise<void> {
      for (const service of services.retireProject(projectPath)) {
        access.revoke({ serviceId: service.id })
        await close(service.id)
      }
    },
    /** Cockpit is closing. */
    async dispose(): Promise<void> {
      unsubscribe()
      for (const id of gateway.openIds()) await close(id)
      access.revoke('all')
    },
    /** For tests and the proof. */
    access,
    services,
  }
}
export type PhonePreviews = ReturnType<typeof createPhonePreviews>
