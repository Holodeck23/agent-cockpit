import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProcessRunner } from '../processes/runner.ts'
import type { ThreadManager } from '../threads/manager.ts'
import type { RemoteAccess } from '../remote/service.ts'

/**
 * One stream for all threads; the client filters by threadId. Process changes
 * go out as a named `process` event so thread listeners never see them. The desktop
 * page also gets `remote` (phone access settings and pairing requests).
 */
export function openSse(req: IncomingMessage, res: ServerResponse, manager: ThreadManager, processes: ProcessRunner, remote?: RemoteAccess): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  const unsubscribe = manager.subscribe((update) => {
    res.write(`data: ${JSON.stringify(update)}\n\n`)
  })
  const unsubscribeProcesses = processes.subscribe((info) => {
    res.write(`event: process\ndata: ${JSON.stringify(info)}\n\n`)
  })
  const unsubscribeRemote = remote?.subscribe(() => {
    res.write(`event: remote\ndata: ${JSON.stringify(remote.status())}\n\n`)
  })
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    unsubscribeProcesses()
    unsubscribeRemote?.()
  })
}
