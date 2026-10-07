import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensurePrivateDir, writeFileAtomic } from '../../files/atomic.ts'

// Phone previews (H5, W11.1): each logical dev service gets its own HTTPS origin on the Mac's
// tailnet name, one `tailscale serve` port from 8443–8458 in front of its own loopback listener
// from 47822–47837. A logical service is a folder + a name + the exact command Cockpit started;
// every Cockpit start or restart of it is a new generation (the process id). Anything else on the
// same port, or another command under the same name, is not the same service.
//
// The mapping is persisted so an origin is never handed to an unrelated service: a mapping whose
// app has stopped keeps its slot, which keeps an old tab from acting on a newly assigned app. At
// sixteen services the limit is shown, never worked around by reusing a slot.

export const PREVIEW_HTTPS_PORTS = { first: 8443, count: 16 } as const
export const PREVIEW_LISTEN_PORTS = { first: 47822, count: 16 } as const

const mappingSchema = z.object({
  id: z.string().min(1),
  slot: z.number().int().min(0).max(PREVIEW_HTTPS_PORTS.count - 1),
  projectPath: z.string().min(1),
  name: z.string().min(1),
  /** sha256 of the command, so the command line itself is not kept here. */
  commandHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  /** Its project was removed: sessions end and it is never previewed again, but its origin stays reserved. */
  retiredAt: z.string().optional(),
})
export type PreviewService = z.output<typeof mappingSchema>

const fileSchema = z.object({ version: z.literal(1), services: z.array(mappingSchema) })

export interface PreviewSlot {
  readonly httpsPort: number
  readonly listenPort: number
}

export const slotPorts = (slot: number): PreviewSlot => ({ httpsPort: PREVIEW_HTTPS_PORTS.first + slot, listenPort: PREVIEW_LISTEN_PORTS.first + slot })

export const commandHash = (command: string): string => createHash('sha256').update(command).digest('hex')

/** The identity of a process that could be previewed: what it is, not which run of it. */
export interface ServiceIdentity {
  readonly projectPath: string
  readonly name: string
  readonly command: string
}

export class PreviewCapacityError extends Error {}
export class PreviewStoreError extends Error {}

export interface PreviewServiceStore {
  list(): PreviewService[]
  get(id: string): PreviewService | undefined
  /** The mapping for this identity, if one exists. */
  find(identity: ServiceIdentity): PreviewService | undefined
  /** The mapping for this identity, created in a free slot if needed. */
  ensure(identity: ServiceIdentity): PreviewService
  /**
   * A folder is no longer a project: its mappings are retired (returned so their sessions can be
   * ended) and keep their origins, since an open phone tab on one could otherwise script a newly
   * assigned app on the same origin.
   */
  retireProject(projectPath: string): PreviewService[]
  /** Set when the file could not be read: it is left as found and nothing new is assigned. */
  readonly damaged: string | undefined
}

/**
 * `reserved` are ports something else on this Mac already uses for Cockpit (the control listener's
 * HTTPS port and its loopback port); a slot that would use one is skipped, never shared.
 */
export function createPreviewServiceStore(root: string, reserved: { httpsPorts?: readonly number[]; listenPorts?: readonly number[] } = {}, now = () => new Date()): PreviewServiceStore {
  ensurePrivateDir(root)
  const file = join(root, 'phone-previews.json')
  let damaged: string | undefined
  let services: PreviewService[] = []
  if (existsSync(file)) {
    try {
      services = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).services
    } catch (error) {
      damaged = `Phone preview settings could not be read and were left as they are (${file}): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    }
  }
  const save = (next: PreviewService[]): void => {
    writeFileAtomic(file, JSON.stringify({ version: 1, services: next }, null, 2))
    services = next
  }
  const usable = (slot: number): boolean => {
    const { httpsPort, listenPort } = slotPorts(slot)
    return !(reserved.httpsPorts ?? []).includes(httpsPort) && !(reserved.listenPorts ?? []).includes(listenPort)
  }
  const matches = (s: PreviewService, identity: ServiceIdentity): boolean =>
    s.retiredAt === undefined && s.projectPath === identity.projectPath && s.name === identity.name && s.commandHash === commandHash(identity.command)

  return {
    get damaged() { return damaged },
    list: () => [...services],
    get: (id) => services.find((s) => s.id === id),
    find: (identity) => services.find((s) => matches(s, identity)),
    ensure(identity) {
      const existing = services.find((s) => matches(s, identity))
      if (existing) return existing
      if (damaged) throw new PreviewStoreError(damaged)
      const taken = new Set(services.map((s) => s.slot))
      const slot = Array.from({ length: PREVIEW_HTTPS_PORTS.count }, (_, i) => i).find((i) => !taken.has(i) && usable(i))
      if (slot === undefined) {
        throw new PreviewCapacityError(`Phone previews are limited to ${services.length} apps on this Mac, and every place is assigned. Places are never reused, so an open phone tab cannot reach a different app.`)
      }
      const created: PreviewService = { id: randomUUID(), slot, projectPath: identity.projectPath, name: identity.name, commandHash: commandHash(identity.command), createdAt: now().toISOString() }
      save([...services, created])
      return created
    },
    retireProject(projectPath) {
      const at = now().toISOString()
      const retiring = services.filter((s) => s.projectPath === projectPath && s.retiredAt === undefined)
      if (retiring.length && !damaged) save(services.map((s) => (retiring.includes(s) ? { ...s, retiredAt: at } : s)))
      return retiring
    },
  }
}
