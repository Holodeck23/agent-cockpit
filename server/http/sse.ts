import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ThreadManager } from '../threads/manager.ts'

/** One stream for all threads; the client filters by threadId. */
export function openSse(req: IncomingMessage, res: ServerResponse, manager: ThreadManager): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  const unsubscribe = manager.subscribe((update) => {
    res.write(`data: ${JSON.stringify(update)}\n\n`)
  })
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}
