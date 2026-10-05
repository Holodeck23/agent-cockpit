import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProcessRunner } from '../processes/runner.ts'
import type { ThreadManager } from '../threads/manager.ts'
import type { RemoteAccess } from '../remote/service.ts'

/**
 * One stream for all threads; the client filters by threadId. Process changes
 * go out as a named `process` event so thread listeners never see them. The desktop
 * page also gets `remote` (phone access settings and pairing requests).
 */
export const MAX_BUFFERED_BYTES = 8_000_000

export function openSse(req: IncomingMessage, res: ServerResponse, manager: ThreadManager, processes: ProcessRunner, remote?: RemoteAccess): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  // A client that stopped reading (a phone on a slow link, a suspended tab) would otherwise have
  // every event buffered for it without limit. Past the limit it is dropped; EventSource
  // reconnects on its own and the page reloads what it shows.
  const send = (chunk: string): void => {
    if (res.destroyed) return
    if (res.writableLength > MAX_BUFFERED_BYTES) { res.destroy(); return }
    res.write(chunk)
  }
  const unsubscribe = manager.subscribe((update) => {
    send(`data: ${JSON.stringify(update)}\n\n`)
  })
  const unsubscribeProcesses = processes.subscribe((info) => {
    send(`event: process\ndata: ${JSON.stringify(info)}\n\n`)
  })
  const unsubscribeRemote = remote?.subscribe(() => {
    send(`event: remote\ndata: ${JSON.stringify(remote.status())}\n\n`)
  })
  const heartbeat = setInterval(() => send(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    unsubscribeProcesses()
    unsubscribeRemote?.()
  })
}
