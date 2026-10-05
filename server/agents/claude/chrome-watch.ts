import type { EventSink, NormalizedEvent } from '../types.ts'

// Use my Chrome (H4, W9-12). Claude reports its Chrome tools as ready at startup even with Chrome
// closed (probed on 2.1.289), so the connection is judged by the first Chrome call itself: it is
// "connecting" until its result arrives. An earlier spike saw such calls stall for many minutes, so
// a call that has not answered within the limit fails the connection and stops the turn, once,
// with what to check. Nothing here touches Chrome itself: Stop and Quit end only Claude's process.

export const CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__'
export const CHROME_CONNECT_MS = 30_000
export const CHROME_TROUBLESHOOTING = 'Chrome did not answer within 30 seconds, so Cockpit stopped this turn. Check that Google Chrome is open, ' +
  'that the Claude extension is installed and signed in to the same account as Claude Code, then send your message again. ' +
  'To work without it, turn off Use my Chrome in the agent settings. Your conversation is kept.'

// Claude 2.1.289 answers a call it could not deliver with a normal (not error) result whose text
// says so: "Browser extension is not connected. Please ensure…" (live probe, order-11/chrome-live).
const DROPPED = /not connected|disconnected|no (?:browser|extension)|extension.*(?:unavailable|not (?:found|running))/i

export interface ChromeWatchTimers {
  readonly set: (run: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
}

const realTimers: ChromeWatchTimers = { set: (run, ms) => setTimeout(run, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/** Wraps a Claude session's event sink; `interrupt` stops the turn when the connection times out. */
export function watchChrome(emit: EventSink, interrupt: () => void, timers: ChromeWatchTimers = realTimers, timeoutMs = CHROME_CONNECT_MS): EventSink {
  let state: 'idle' | 'connecting' | 'connected' = 'idle'
  let timer: unknown
  const calls = new Set<string>()
  const status = (phase: Extract<NormalizedEvent, { kind: 'chrome_connection' }>['phase'], detail?: string): void =>
    emit({ kind: 'chrome_connection', phase, ...(detail ? { detail } : {}) })
  const stopTimer = (): void => { if (timer !== undefined) timers.clear(timer); timer = undefined }

  return (event) => {
    emit(event)
    if (event.kind === 'tool_use' && event.name.startsWith(CHROME_TOOL_PREFIX)) {
      calls.add(event.id)
      if (state === 'idle') {
        state = 'connecting'
        status('connecting')
        timer = timers.set(() => {
          timer = undefined
          if (state !== 'connecting') return
          state = 'idle'
          status('failed', CHROME_TROUBLESHOOTING)
          interrupt()
        }, timeoutMs)
      }
    } else if (event.kind === 'tool_result' && calls.delete(event.toolUseId)) {
      if (state === 'connecting') {
        stopTimer()
        if (event.isError || DROPPED.test(event.content)) { state = 'idle'; status('failed', event.content.slice(0, 300)) }
        else { state = 'connected'; status('connected') }
      } else if (state === 'connected' && DROPPED.test(event.content)) {
        state = 'idle'
        status('disconnected', event.content.slice(0, 300))
      }
    } else if (event.kind === 'result' || event.kind === 'exit') {
      calls.clear()
      if (state === 'connecting') { stopTimer(); state = 'idle'; status('cancelled') }
      if (event.kind === 'exit') { stopTimer(); state = 'idle' }
    }
  }
}
