import type { StoredEvent } from './types.ts'

/**
 * Positions of events that are no longer part of the conversation: each message you took back
 * (a `user_text` whose queued id has a `user_unqueued`), and the images you sent with it, which
 * are stored straight after it. The transcript and the switch handoff both use this one rule.
 */
export function takenBackPositions(events: readonly StoredEvent[]): ReadonlySet<number> {
  const takenBack = new Set(events.flatMap((e) => (e.event.kind === 'user_unqueued' ? [e.event.id] : [])))
  const skip = new Set<number>()
  let skippingImages = false
  events.forEach(({ event }, index) => {
    if (skippingImages && event.kind === 'image' && event.from === 'you') { skip.add(index); return }
    skippingImages = event.kind === 'user_text' && event.queuedId !== undefined && takenBack.has(event.queuedId)
    if (skippingImages) skip.add(index)
  })
  return skip
}
