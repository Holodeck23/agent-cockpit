// Cockpit service worker: shows "needs you" notifications sent by the Mac and
// opens the conversation when one is tapped. It caches nothing; the page is
// always loaded fresh from the Mac.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let message = { title: 'Cockpit', body: 'A conversation needs you.', threadId: '' }
  try {
    message = { ...message, ...event.data.json() }
  } catch {
    // keep the default text
  }
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/maskable-192.png',
    tag: message.threadId || 'cockpit',
    renotify: true,
    data: { url: message.threadId ? `/?thread=${encodeURIComponent(message.threadId)}` : '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
    if (open) {
      await open.focus()
      return open.navigate(url)
    }
    return self.clients.openWindow(url)
  })())
})
