import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'
import { z } from 'zod'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'

// "Needs you" notifications for paired phones, over Web Push. Payloads are
// encrypted for the phone's own keys (RFC 8291), so the push service in between
// (Google's, for Chrome on Android) cannot read the conversation title.
// <root>/push.json holds this Mac's signing keys and each phone's subscription.

const subscriptionSchema = z.object({
  endpoint: z.url().refine((url) => url.startsWith('https://'), 'Push endpoints are HTTPS'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
})
export type PushSubscription = z.output<typeof subscriptionSchema>
export const pushSubscriptionBody = z.object({ subscription: subscriptionSchema })

const fileSchema = z.object({
  publicKey: z.string(),
  privateKey: z.string(),
  subscriptions: z.array(z.object({ deviceId: z.string(), subscription: subscriptionSchema })).default([]),
})
type PushFile = z.output<typeof fileSchema>

export interface PushMessage { readonly title: string; readonly body: string; readonly threadId: string }
/** Sends one encrypted message; resolves with the push service's HTTP status. */
export type PushSender = (subscription: PushSubscription, payload: string, keys: { publicKey: string; privateKey: string }) => Promise<number>

export const webPushSender: PushSender = async (subscription, payload, keys) => {
  try {
    const result = await webpush.sendNotification(subscription, payload, {
      vapidDetails: { subject: 'https://github.com/Holodeck23/agent-cockpit', ...keys },
      TTL: 3600,
      urgency: 'high',
      timeout: 15_000,
    })
    return result.statusCode
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    if (status) return status
    throw error
  }
}

export function createPushStore(root: string) {
  const file = join(root, 'push.json')
  const write = (data: PushFile): PushFile => {
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    return data
  }
  const read = (): PushFile => {
    if (existsSync(file)) return fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    return write({ ...webpush.generateVAPIDKeys(), subscriptions: [] })
  }
  return {
    publicKey: (): string => read().publicKey,
    keys: () => { const { publicKey, privateKey } = read(); return { publicKey, privateKey } },
    subscriptions: () => read().subscriptions,
    subscribe(deviceId: string, subscription: PushSubscription): void {
      const data = read()
      const others = data.subscriptions.filter((s) => s.subscription.endpoint !== subscription.endpoint)
      write({ ...data, subscriptions: [...others, { deviceId, subscription }] })
    },
    unsubscribe(match: { deviceId?: string; endpoint?: string }): void {
      const data = read()
      write({ ...data, subscriptions: data.subscriptions.filter((s) =>
        !(match.deviceId !== undefined && s.deviceId === match.deviceId) && !(match.endpoint !== undefined && s.subscription.endpoint === match.endpoint)) })
    },
    has: (deviceId: string): boolean => read().subscriptions.some((s) => s.deviceId === deviceId),
  }
}
export type PushStore = ReturnType<typeof createPushStore>

export interface NotifierOptions {
  readonly push: PushStore
  readonly manager: ThreadManager
  readonly threads: ThreadStore
  /** Only notify while phone access is on and the subscription's phone is still paired. */
  readonly active: () => boolean
  readonly paired: (deviceId: string) => boolean
  readonly projectName: (path: string) => string
  readonly send?: PushSender
  /** For tests and logs: each delivery attempt. */
  readonly onSent?: (result: { deviceId: string; status: number | 'error'; message: PushMessage }) => void
}

/** One notification per approval request, when a conversation starts needing you. */
export function startNotifier({ push, manager, threads, active, paired, projectName, send = webPushSender, onSent }: NotifierOptions): () => void {
  return manager.subscribe(({ threadId, event, status }) => {
    if (event.kind !== 'approval_request' || status !== 'needs_input' || !active()) return
    const meta = threads.get(threadId)
    if (!meta) return
    const message: PushMessage = { title: 'Needs you', body: `${projectName(meta.projectPath)}: ${meta.title}`, threadId }
    const payload = JSON.stringify(message)
    const keys = push.keys()
    for (const { deviceId, subscription } of push.subscriptions()) {
      if (!paired(deviceId)) continue
      send(subscription, payload, keys).then((code) => {
        // Gone or not found: the phone dropped this subscription; stop sending to it.
        if (code === 404 || code === 410) push.unsubscribe({ endpoint: subscription.endpoint })
        onSent?.({ deviceId, status: code, message })
      }, () => onSent?.({ deviceId, status: 'error', message }))
    }
  })
}
