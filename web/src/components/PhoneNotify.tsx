import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { BellIcon } from './icons.tsx'
import { disableNotifications, notificationsEnabled } from '../notifications.ts'

// Phone only: turn "needs you" notifications on or off for this phone. Chrome
// asks for permission on the tap; the subscription is sent to the Mac, which
// encrypts every message for this phone's keys.

type State = 'unsupported' | 'blocked' | 'off' | 'on' | 'busy'

function urlKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js')
  return navigator.serviceWorker.ready
}

const LABEL: Record<State, string> = {
  unsupported: 'Notifications are not available in this browser',
  blocked: 'Notifications are blocked for this site in Chrome settings',
  off: 'Turn on notifications',
  on: 'Notifications are on. Tap to turn off',
  busy: 'Working…',
}

export function PhoneNotify({ initiallyOn, onError }: { initiallyOn: boolean; onError: (message: string) => void }) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [state, setState] = useState<State>(() =>
    !supported ? 'unsupported' : Notification.permission === 'denied' ? 'blocked' : 'busy')

  // Keep the worker registered so taps on notifications open the right conversation.
  useEffect(() => {
    let cancelled = false
    if (supported) void registration().then(async (reg) => {
      const on = await notificationsEnabled(initiallyOn, Notification.permission, reg.pushManager)
      if (!cancelled) setState(Notification.permission === 'denied' ? 'blocked' : on ? 'on' : 'off')
    }).catch((error: unknown) => {
      if (!cancelled) { setState('off'); onError(String(error)) }
    })
    return () => { cancelled = true }
  }, [supported, initiallyOn, onError])

  const toggle = async (): Promise<void> => {
    if (state === 'unsupported' || state === 'blocked' || state === 'busy') return
    const wasOn = state === 'on'
    let browserDisabled = false
    setState('busy')
    try {
      if (wasOn) {
        const reg = await registration()
        await disableNotifications(reg.pushManager, api.pushUnsubscribe, () => {
          browserDisabled = true
        })
        setState('off')
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off')
        return
      }
      const reg = await registration()
      const { publicKey } = await api.pushKey()
      const existing = await reg.pushManager.getSubscription()
      const subscription = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(publicKey) })
      await api.pushSubscribe(subscription.toJSON())
      setState('on')
    } catch (error) {
      setState(wasOn && !browserDisabled ? 'on' : 'off')
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <button type="button" className={`icon-button notify-button${state === 'on' ? ' on' : ''}`} aria-label={LABEL[state]} title={LABEL[state]}
      aria-pressed={state === 'on'} disabled={state === 'unsupported' || state === 'busy'} onClick={() => void toggle()}>
      <BellIcon />
    </button>
  )
}
