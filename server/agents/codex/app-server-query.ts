// One question to `codex app-server` without starting a thread: initialize, ask, stop. Used for
// non-generating checks (model/list, account/read). Bounded by a timeout; the process is killed
// when the answer arrives or the time is up.
import { spawn } from 'node:child_process'

export interface AppServerAnswer {
  readonly result?: unknown
  /** Why there is no result: the server's error, a start failure, a timeout or an early exit. */
  readonly error?: string
}

export type AppServerQuery = (executable: string, method: string, params: unknown, options: { env?: Readonly<Record<string, string>>; timeoutMs: number; signal?: AbortSignal }) => Promise<AppServerAnswer>

export const queryAppServer: AppServerQuery = (executable, method, params, { env, timeoutMs, signal }) =>
  new Promise((resolve) => {
    if (signal?.aborted) { resolve({ error: 'Cockpit is shutting down' }); return }
    let settled = false
    let answer: AppServerAnswer | undefined
    const child = spawn(executable, ['app-server'], { env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'ignore'] })
    const done = (result: AppServerAnswer): void => {
      if (settled) return
      settled = true
      answer = result
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      // Resolve only after the owned helper's process and stdio have actually closed.
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    const abort = (): void => done({ error: 'Cockpit is shutting down' })
    const timer = setTimeout(() => done({ error: `codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => done({ error: `codex app-server could not start (${(error as NodeJS.ErrnoException).code ?? error.message})` }))
    child.on('exit', () => done({ error: `codex app-server ended before answering ${method}` }))
    child.on('close', () => { done({ error: `codex app-server ended before answering ${method}` }); resolve(answer!) })
    child.stdin.on('error', () => {})
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
        try { message = JSON.parse(line) as typeof message } catch { continue }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method, params })}\n`)
        } else if (message.id === 2) {
          done(message.error ? { error: `${method} failed: ${String(message.error.message ?? 'no detail')}` } : { result: message.result })
        }
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-cockpit', title: 'Agent Cockpit', version: '1' }, capabilities: null } })}\n`)
  })

/** One server owns its non-generating helpers, including probes still starting during Quit. */
export function createAppServerQueryScope(): { query: AppServerQuery; close(): Promise<void> } {
  const controller = new AbortController()
  const pending = new Set<Promise<AppServerAnswer>>()
  return {
    query: (executable, method, params, options) => {
      const promise = queryAppServer(executable, method, params, { ...options, signal: controller.signal })
      pending.add(promise)
      void promise.then(() => pending.delete(promise), () => pending.delete(promise))
      return promise
    },
    async close() {
      controller.abort()
      await Promise.all([...pending])
    },
  }
}
