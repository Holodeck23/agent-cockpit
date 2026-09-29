import { describe, expect, it, vi } from 'vitest'
import { disableNotifications, notificationsEnabled } from '../web/src/notifications.ts'

describe('phone notification state', () => {
  it('stays off after browser unsubscribe even when the Mac is unreachable, including after reload', async () => {
    let subscription: PushSubscription | null = {
      unsubscribe: async () => { subscription = null; return true },
    } as PushSubscription
    const manager = { getSubscription: async () => subscription }
    const disabled = vi.fn()
    await expect(disableNotifications(manager, async () => { throw new Error('offline') }, disabled)).rejects.toThrow('offline')
    expect(disabled).toHaveBeenCalledOnce()
    expect(await notificationsEnabled(true, 'granted', manager)).toBe(false)
  })

  it('keeps the enabled state when browser unsubscribe itself fails', async () => {
    const manager = { getSubscription: async () => ({ unsubscribe: async () => { throw new Error('browser failed') } }) as unknown as PushSubscription }
    const remove = vi.fn()
    const disabled = vi.fn()
    await expect(disableNotifications(manager, remove, disabled)).rejects.toThrow('browser failed')
    expect(disabled).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(await notificationsEnabled(true, 'granted', manager)).toBe(true)
  })

  it('requires permission and a server subscription as well as a browser subscription', async () => {
    const manager = { getSubscription: async () => ({}) as PushSubscription }
    expect(await notificationsEnabled(false, 'granted', manager)).toBe(false)
    expect(await notificationsEnabled(true, 'denied', manager)).toBe(false)
    expect(await notificationsEnabled(true, 'granted', manager)).toBe(true)
  })
})
