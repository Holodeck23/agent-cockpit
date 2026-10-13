import type { RpcClient } from './rpc.ts'

interface Command { readonly threadId: string; readonly turnId: string; readonly processId: string }
interface Stop { readonly pending: Set<Promise<void>>; readonly errors: string[]; readonly terminals: Set<string> }
const keyOf = (threadId: string, turnId: string): string => JSON.stringify([threadId, turnId])
const STOP_TIMEOUT_MS = 5000

/** Model-issued unified_exec terminals survive turn/interrupt in Codex 0.162.1. Their IDs
 * belong to the thread terminal store, NOT command/exec or process/spawn. Track only IDs
 * reported by this connection's active items and terminate only those in the stopped turn. */
export function createCodexStop(rpc: RpcClient, onInterruptError: (message: string) => void) {
  const commands = new Map<string, Command>()
  const stops = new Map<string, Stop>()
  const terminate = (command: Command, stop: Stop): void => {
    if (stop.terminals.has(command.processId)) return
    stop.terminals.add(command.processId)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('terminal cancellation timed out')), STOP_TIMEOUT_MS)
    })
    const pending = Promise.race([
      rpc.request<{ terminated: boolean }>('thread/backgroundTerminals/terminate', { threadId: command.threadId, processId: command.processId }),
      timeout,
    ]).then((result) => {
      if (!result.terminated && [...commands.values()].includes(command)) throw new Error('Codex did not confirm terminal termination')
    }).catch((error: unknown) => {
      stop.errors.push(`Codex could not confirm command Stop; the command may still be running: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { clearTimeout(timer); stop.pending.delete(pending) })
    stop.pending.add(pending)
  }
  return {
    observe(method: string, params: unknown): void {
      const p = params as { threadId?: string; turnId?: string; item?: { id?: string; type?: string; processId?: string | null } } | undefined
      if (!p?.threadId || !p.turnId || p.item?.type !== 'commandExecution' || !p.item.id) return
      const key = keyOf(p.threadId, p.item.id)
      if (method === 'item/completed') { commands.delete(key); return }
      if (method !== 'item/started' || typeof p.item.processId !== 'string' || commands.has(key)) return
      const command = { threadId: p.threadId, turnId: p.turnId, processId: p.item.processId }
      commands.set(key, command)
      const stop = stops.get(keyOf(command.threadId, command.turnId))
      if (stop) terminate(command, stop) // Stop may precede the command's started notification.
    },
    interrupt(threadId: string, turnId: string): void {
      const key = keyOf(threadId, turnId)
      if (stops.has(key)) return
      const stop: Stop = { pending: new Set(), errors: [], terminals: new Set() }
      stops.set(key, stop)
      // Request both independently: interrupt can complete while the terminal is still alive.
      rpc.request('turn/interrupt', { threadId, turnId }).catch((error: unknown) => {
        onInterruptError(`Codex could not interrupt the turn: ${error instanceof Error ? error.message : String(error)}`)
      })
      for (const command of commands.values()) {
        if (command.threadId === threadId && command.turnId === turnId) terminate(command, stop)
      }
    },
    finish(threadId: string, turnId: string, deliver: (errors: readonly string[]) => void): void {
      const key = keyOf(threadId, turnId)
      const stop = stops.get(key)
      const done = (): void => {
        stops.delete(key)
        for (const [id, command] of commands) {
          if (command.threadId === threadId && command.turnId === turnId) commands.delete(id)
        }
        deliver(stop?.errors ?? [])
      }
      if (!stop?.pending.size) { done(); return }
      void (async () => {
        while (stop.pending.size) await Promise.all([...stop.pending])
        done()
      })()
    },
  }
}
