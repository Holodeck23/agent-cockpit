import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { HttpError, parseBody, readJson, sendJson } from '../http/json.ts'
import { checkRemote, cookieValues, isRemoteRoute, remoteAuthority } from './guard.ts'
import type { DeviceView, RemoteStore } from './store.ts'
import { pushSubscriptionBody, webPushSender, type PushSender, type PushStore } from './push.ts'
import { TailscaleError, type Tailscale, type TailscaleSelf } from './tailscale.ts'
import type { GatewayPolicy } from './preview/gateway.ts'
import type { PhonePreviews } from './preview/control.ts'

// Phone access: a second HTTP listener on a fixed 127.0.0.1 port that only
// `tailscale serve` reaches. It serves the same page and a subset of the API,
// behind the Tailscale identity check (guard.ts) and a per-phone pairing
// cookie approved on the Mac. The desktop listener and its guard are unchanged.

export const DEVICE_COOKIE = 'cockpit_device'

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, remote?: boolean) => Promise<boolean>

export interface RemoteStatus {
  readonly enabled: boolean
  readonly running: boolean
  readonly port: number
  readonly url?: string
  readonly login?: string
  readonly allowedLogins: string[]
  readonly devices: (DeviceView & { notifications: boolean })[]
  readonly pairings: { id: string; code: string; name: string; login: string }[]
  readonly error?: string
}

export interface RemoteAccessOptions {
  readonly store: RemoteStore
  readonly tailscale: Tailscale
  readonly serveStatic: (pathname: string, res: ServerResponse) => void
  /** Overrides the saved port; 0 picks a free one (tests). */
  readonly port?: number
  /** Notification subscriptions for paired phones. */
  readonly push: PushStore
  readonly sendPush?: PushSender
}

const enabledBody = z.object({ enabled: z.boolean() })
const decisionBody = z.object({ approve: z.boolean() })
const pairBody = z.object({ name: z.string().max(80).default('Phone') })
const ticketBody = z.object({ processId: z.string().min(1).max(200) })

/** What phone access tells phone previews (preview/control.ts) about. */
export type PreviewHooks = Pick<PhonePreviews, 'ticket' | 'started' | 'stopped' | 'deviceRevoked'>

export function createRemoteAccess({ store, tailscale, serveStatic, port: portOverride, push, sendPush = webPushSender }: RemoteAccessOptions) {
  let api: ApiHandler | undefined
  let previews: PreviewHooks | undefined
  let server: Server | undefined
  let self: TailscaleSelf | undefined
  let error: string | undefined
  const configuredPort = (): number => portOverride ?? store.read().port
  const boundPort = (): number | undefined => (server?.listening ? (server.address() as AddressInfo).port : undefined)
  const listeners = new Set<() => void>()
  // Open live streams per paired phone, so revoking a phone can end them.
  const streams = new Map<string, Set<ServerResponse>>()
  const endStreams = (deviceId: string): void => {
    for (const res of streams.get(deviceId) ?? []) res.destroy()
    streams.delete(deviceId)
  }
  const changed = (): void => { for (const listener of listeners) listener() }

  const status = (): RemoteStatus => {
    const config = store.read()
    return {
      enabled: config.enabled,
      running: Boolean(server?.listening),
      port: boundPort() ?? configuredPort(),
      ...(self ? { url: `https://${remoteAuthority({ ...policy(), hostname: self.hostname })}`, login: self.login } : {}),
      allowedLogins: config.allowedLogins,
      devices: store.devices().map((d) => ({ ...d, notifications: push.has(d.id) })),
      pairings: store.pendingPairings().map(({ id, code, name, login }) => ({ id, code, name, login })),
      ...(error ? { error } : {}),
    }
  }

  const policy = () => {
    const config = store.read()
    return { hostname: self?.hostname ?? '', allowedLogins: config.allowedLogins, httpsPort: config.httpsPort }
  }

  async function handleRemote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isApi = url.pathname.startsWith('/api/')
    // No other page may frame the phone page or its answers (it holds approvals). No CORS, ever.
    res.setHeader('x-frame-options', 'DENY')
    const check = checkRemote(req, policy())
    if (!check.ok) {
      if (isApi) return sendJson(res, check.status, { error: check.error })
      res.writeHead(check.status, { 'content-type': 'text/plain; charset=utf-8' })
      return void res.end(check.error)
    }
    // The page itself is the public app; it asks to pair before showing anything.
    if (!isApi) return serveStatic(url.pathname, res)
    try {
      const method = req.method ?? 'GET'
      // Cookies are shared across ports, so a preview origin's page could add a second one on a
      // narrower path (SEC-04). Two is ambiguous, and ambiguous is no sign-in at all.
      const deviceCookies = cookieValues(req, DEVICE_COOKIE)
      if (deviceCookies.length > 1) {
        return sendJson(res, 400, { error: 'This browser sent two Cockpit sign-ins. Clear this site\'s data in the browser, then pair the phone again.' })
      }
      const device = store.deviceFor(deviceCookies[0], check.login)
      if (url.pathname === '/api/remote/me' && method === 'GET') {
        return sendJson(res, 200, { data: { mode: 'remote', login: check.login, paired: Boolean(device),
          notifications: device ? push.has(device.id) : false } })
      }
      if (url.pathname === '/api/remote/pair' && method === 'POST') {
        const request = store.requestPairing(parseBody(pairBody, await readJson(req)).name, check.login)
        changed()
        return sendJson(res, 201, { data: { id: request.id, code: request.code } })
      }
      const polled = /^\/api\/remote\/pair\/([^/]+)$/.exec(url.pathname)
      if (polled && method === 'GET') {
        const result = store.redeem(polled[1] ?? '', check.login)
        if (!result) throw new HttpError(404, 'This pairing request has expired')
        if (result.token) {
          changed()
          res.setHeader('set-cookie', `${DEVICE_COOKIE}=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`)
        }
        return sendJson(res, 200, { data: { status: result.status } })
      }
      if (!device) return sendJson(res, 401, { error: 'Pair this phone with Cockpit on your Mac first' })
      // View app (W11.2): a one-use ticket for one running process, never a phone-supplied address.
      if (url.pathname === '/api/phone/preview-tickets' && method === 'POST') {
        if (!previews) return sendJson(res, 404, { error: 'Phone previews are not available' })
        const result = await previews.ticket({ deviceId: device.id, login: check.login, processId: parseBody(ticketBody, await readJson(req)).processId })
        return 'state' in result ? sendJson(res, 409, { error: result.error, state: result.state }) : sendJson(res, 201, { data: result })
      }
      if (url.pathname === '/api/remote/push/key' && method === 'GET') return sendJson(res, 200, { data: { publicKey: push.publicKey() } })
      if (url.pathname === '/api/remote/push/subscribe' && method === 'POST') {
        push.subscribe(device.id, parseBody(pushSubscriptionBody, await readJson(req)).subscription)
        changed()
        return sendJson(res, 200, { data: { notifications: true } })
      }
      if (url.pathname === '/api/remote/push/unsubscribe' && method === 'POST') {
        push.unsubscribe({ deviceId: device.id })
        changed()
        return sendJson(res, 200, { data: { notifications: false } })
      }
      if (!isRemoteRoute(method, url.pathname) || !api) return sendJson(res, 403, { error: 'Not available from the phone' })
      // The live stream is one long request: a phone revoked while it is open must not keep receiving it.
      if (url.pathname === '/api/stream') {
        const open = streams.get(device.id) ?? new Set<ServerResponse>()
        streams.set(device.id, open.add(res))
        res.once('close', () => { open.delete(res); if (open.size === 0 && streams.get(device.id) === open) streams.delete(device.id) })
      }
      await api(req, res, true)
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 400
      if (!res.headersSent) sendJson(res, code, { error: err instanceof Error ? err.message : 'Request failed' })
    }
  }

  async function listen(port: number): Promise<void> {
    if (server?.listening) return
    const next = createServer((req, res) => void handleRemote(req, res))
    await new Promise<void>((resolve, reject) => {
      next.once('error', (err: NodeJS.ErrnoException) =>
        reject(new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use on this Mac` : err.message)))
      next.listen(port, '127.0.0.1', () => resolve())
    })
    server = next
  }

  async function stopListening(): Promise<void> {
    const current = server
    server = undefined
    await previews?.stopped()
    if (!current) return
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      current.closeAllConnections()
    })
  }

  async function enable(): Promise<RemoteStatus> {
    try {
      self = await tailscale.self()
      if (store.read().allowedLogins.length === 0) store.update({ allowedLogins: [self.login] })
      await listen(configuredPort())
      const port = boundPort()!
      const ours = `http://127.0.0.1:${port}`
      const { httpsPort } = store.read()
      const target = await tailscale.serveTarget(self.hostname, httpsPort)
      if (target && target !== ours) {
        throw new TailscaleError(`HTTPS on this Mac's Tailscale address already goes to ${target}. Turn that off first.`)
      }
      if (!target) await tailscale.serve(port, httpsPort)
      store.update({ enabled: true })
      error = undefined
      await previews?.started()
    } catch (err) {
      await stopListening()
      error = err instanceof Error ? err.message : String(err)
      throw new HttpError(400, error)
    } finally {
      changed()
    }
    return status()
  }

  async function disable(): Promise<RemoteStatus> {
    store.update({ enabled: false })
    try {
      const port = boundPort() ?? configuredPort()
      const hostname = self?.hostname ?? (await tailscale.self()).hostname
      const { httpsPort } = store.read()
      if ((await tailscale.serveTarget(hostname, httpsPort)) === `http://127.0.0.1:${port}`) await tailscale.unserve(httpsPort)
      error = undefined
    } catch (err) {
      error = `Phone access is off, but Tailscale could not be updated: ${err instanceof Error ? err.message : String(err)}`
    }
    await stopListening()
    changed()
    return status()
  }

  /** Desktop-only settings routes under /api/remote. */
  async function handleLocal(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const method = req.method ?? 'GET'
    if (parts.length === 3 && parts[2] === 'me' && method === 'GET') return sendJson(res, 200, { data: { mode: 'local' } })
    if (parts.length === 2 && method === 'GET') return sendJson(res, 200, { data: status() })
    if (parts.length === 2 && method === 'POST') {
      const { enabled } = parseBody(enabledBody, await readJson(req))
      return sendJson(res, 200, { data: enabled ? await enable() : await disable() })
    }
    if (parts[2] === 'pairings' && parts[3] && method === 'POST') {
      try {
        store.decide(parts[3], parseBody(decisionBody, await readJson(req)).approve)
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err))
      }
      changed()
      return sendJson(res, 200, { data: status() })
    }
    if (parts[2] === 'devices' && parts[3] && parts[4] === 'revoke' && method === 'POST') {
      if (!store.revoke(parts[3])) throw new HttpError(404, 'Unknown phone')
      push.unsubscribe({ deviceId: parts[3] })
      endStreams(parts[3])
      previews?.deviceRevoked(parts[3])
      changed()
      return sendJson(res, 200, { data: status() })
    }
    if (parts[2] === 'push' && parts[3] === 'test' && method === 'POST') {
      const payload = JSON.stringify({ title: 'Cockpit', body: 'Notifications from your Mac are working.', threadId: '' })
      const results = await Promise.all(push.subscriptions().map(async ({ deviceId, subscription }) =>
        ({ deviceId, status: await sendPush(subscription, payload, push.keys()).catch(() => 0) })))
      return sendJson(res, 200, { data: { sent: results } })
    }
    throw new HttpError(404, 'Not found')
  }

  return {
    attach(handler: ApiHandler) { api = handler },
    attachPreviews(hooks: PreviewHooks) { previews = hooks },
    /** The control origin's tailnet policy while phone access is running, for the preview listeners. */
    previewPolicy(): GatewayPolicy | undefined {
      if (!server?.listening || !self) return undefined
      const p = policy()
      return { hostname: p.hostname, allowedLogins: p.allowedLogins, controlOrigin: `https://${remoteAuthority(p)}` }
    },
    status,
    handleLocal,
    /** Resumes phone access at launch if it was on. Failures show in the settings, never block startup. */
    async resume(): Promise<void> {
      if (store.read().enabled) await enable().catch(() => undefined)
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Closes the phone listener. The Tailscale serve entry stays, so the phone sees Cockpit is closed. */
    close: stopListening,
    /** The phone listener's port while it runs. */
    port: boundPort,
  }
}
export type RemoteAccess = ReturnType<typeof createRemoteAccess>
