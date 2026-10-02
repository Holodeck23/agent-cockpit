import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

// Minimal JSON-RPC over newline-delimited stdio, as spoken by `codex app-server` and by ACP agents
// (`opencode acp`), which also expect the "jsonrpc": "2.0" member.

export interface ServerRequest {
  readonly id: number | string
  readonly method: string
  readonly params: unknown
}

export interface RpcClient {
  request<T>(method: string, params: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  respond(id: number | string, result: unknown): void
}

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void
  onServerRequest(request: ServerRequest): void
  onProtocolError(message: string): void
}

export function createRpcClient(child: ChildProcessWithoutNullStreams, handlers: RpcHandlers, options: { label?: string; jsonrpc?: boolean } = {}): RpcClient {
  const label = options.label ?? 'Codex'
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const write = (message: unknown): void => {
    if (!child.stdin.writable) {
      handlers.onProtocolError(`${label} process is not running`)
      return
    }
    child.stdin.write(`${JSON.stringify(options.jsonrpc ? { jsonrpc: '2.0', ...(message as object) } : message)}\n`)
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      handlers.onProtocolError(`Unparseable ${label} output: ${line.slice(0, 200)}`)
      return
    }
    const { id, method } = message
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      handlers.onServerRequest({ id, method, params: message.params })
    } else if (typeof method === 'string') {
      handlers.onNotification(method, message.params)
    } else if (typeof id === 'number' && pending.has(id)) {
      const waiter = pending.get(id)
      pending.delete(id)
      if ('error' in message) {
        const error = message.error as { message?: string } | undefined
        waiter?.reject(new Error(error?.message ?? `${label} request failed`))
      } else {
        waiter?.resolve(message.result)
      }
    }
  })

  // close also arrives for failed spawns, which never emit exit.
  child.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`${label} process exited`))
    pending.clear()
  })

  return {
    request<T>(method: string, params: unknown): Promise<T> {
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        write({ id, method, params })
      })
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params })
    },
    respond(id, result) {
      write({ id, result })
    },
  }
}
