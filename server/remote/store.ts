import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { ensurePrivateDir, writeFileAtomic } from '../files/atomic.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// <root>/remote.json: whether phone access is on, which Tailscale logins may use
// it, and the phones paired with this Mac. Device tokens are stored as SHA-256
// hashes; the token itself only ever lives in the phone's cookie.

export const DEFAULT_REMOTE_PORT = 47821
const PAIRING_TTL_MS = 5 * 60_000
const MAX_PENDING = 5

const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().max(80),
  login: z.string(),
  tokenHash: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
})
export type RemoteDevice = z.output<typeof deviceSchema>

const configSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1024).max(65535).default(DEFAULT_REMOTE_PORT),
  /** The HTTPS port Tailscale serves on: 443, 8443 or 10000. */
  httpsPort: z.union([z.literal(443), z.literal(8443), z.literal(10000)]).default(443),
  allowedLogins: z.array(z.string()).default([]),
  devices: z.array(deviceSchema).default([]),
})
export type RemoteConfig = z.output<typeof configSchema>

export interface PairingRequest {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly login: string
  readonly createdAt: number
  readonly status: 'pending' | 'approved' | 'denied'
}

/** A device as the desktop settings show it: no token material. */
export type DeviceView = Omit<RemoteDevice, 'tokenHash'>

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

export function createRemoteStore(root: string, now = Date.now) {
  ensurePrivateDir(root)
  const file = join(root, 'remote.json')
  const read = (): RemoteConfig => configSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
  const write = (config: RemoteConfig): RemoteConfig => {
    writeFileAtomic(file, JSON.stringify(config, null, 2))
    return config
  }
  const pending = new Map<string, PairingRequest>()
  const prune = (): void => {
    for (const [id, request] of pending) if (now() - request.createdAt > PAIRING_TTL_MS) pending.delete(id)
  }

  return {
    read,
    update(patch: Partial<Pick<RemoteConfig, 'enabled' | 'allowedLogins'>>): RemoteConfig {
      return write({ ...read(), ...patch })
    },
    devices(): DeviceView[] {
      return read().devices.map(({ tokenHash: _hash, ...device }) => device)
    },
    /** The paired device holding this token, if it belongs to the same Tailscale login. */
    deviceFor(token: string | undefined, login: string): RemoteDevice | undefined {
      if (!token) return undefined
      const tokenHash = hash(token)
      const config = read()
      const device = config.devices.find((d) => d.tokenHash === tokenHash && d.login.toLowerCase() === login.toLowerCase())
      if (!device) return undefined
      // Record activity at most once a minute so reads don't rewrite the file constantly.
      if (now() - Date.parse(device.lastSeenAt) > 60_000) {
        const seen = new Date(now()).toISOString()
        write({ ...config, devices: config.devices.map((d) => (d.id === device.id ? { ...d, lastSeenAt: seen } : d)) })
      }
      return device
    },
    revoke(id: string): boolean {
      const config = read()
      if (!config.devices.some((d) => d.id === id)) return false
      write({ ...config, devices: config.devices.filter((d) => d.id !== id) })
      return true
    },
    requestPairing(name: string, login: string): PairingRequest {
      prune()
      const cleanName = name.trim().slice(0, 80) || 'Phone'
      const sameLogin = (r: PairingRequest): boolean => r.status === 'pending' && r.login.toLowerCase() === login.toLowerCase()
      // Asking again with the same name replaces the earlier request instead of stacking new ones.
      // It is never handed back: its id is the secret that redeems it, and another phone on the
      // same login could have asked with the same name.
      for (const [id, request] of pending) if (sameLogin(request) && request.name === cleanName) pending.delete(id)
      // At most MAX_PENDING per login, oldest dropped first: requests from one login can never
      // keep another phone, or the owner's own, from pairing.
      const mine = [...pending.entries()].filter(([, r]) => sameLogin(r)).sort(([, a], [, b]) => a.createdAt - b.createdAt)
      for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING + 1))) pending.delete(id)
      const request: PairingRequest = { id: randomUUID(), code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        name: cleanName, login, createdAt: now(), status: 'pending' }
      pending.set(request.id, request)
      return request
    },
    pendingPairings(): PairingRequest[] {
      prune()
      return [...pending.values()].filter((r) => r.status === 'pending')
    },
    decide(id: string, approve: boolean): PairingRequest {
      prune()
      const request = pending.get(id)
      if (!request || request.status !== 'pending') throw new Error('This pairing request has expired')
      const decided = { ...request, status: approve ? 'approved' : 'denied' } as const
      pending.set(id, decided)
      return decided
    },
    /**
     * The phone polls its own request. An approved request is redeemed exactly
     * once for a new device token; the request id is the phone's secret.
     */
    redeem(id: string, login: string): { status: PairingRequest['status']; token?: string } | undefined {
      prune()
      const request = pending.get(id)
      if (!request || request.login.toLowerCase() !== login.toLowerCase()) return undefined
      if (request.status !== 'approved') return { status: request.status }
      pending.delete(id)
      const token = randomBytes(32).toString('base64url')
      const at = new Date(now()).toISOString()
      const config = read()
      write({ ...config, devices: [...config.devices, { id: randomUUID(), name: request.name, login: request.login,
        tokenHash: hash(token), createdAt: at, lastSeenAt: at }] })
      return { status: 'approved', token }
    },
  }
}
export type RemoteStore = ReturnType<typeof createRemoteStore>
