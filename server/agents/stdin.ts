import type { ChildProcess } from 'node:child_process'

/**
 * A CLI that dies, or closes its stdin, before Node has seen it exit still looks writable, and
 * the next write fails later as an 'error' event (EPIPE). Unhandled, that event throws: under
 * `npm start` it ends the server and every agent with it; in the app it puts up the main-process
 * error box. The pipe is destroyed by then, so later writes already see it as not writable, and
 * the exit handler reports the end of the session. `onLost` only tells the user this write is lost.
 */
export function guardStdin(child: ChildProcess, onLost: (error: Error) => void): void {
  child.stdin?.on('error', onLost)
}
