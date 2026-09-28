// Captured output of one long-running process: split into lines, stripped of
// terminal colour codes (the reader is an agent, not a terminal), numbered so a
// reader can ask for "everything after line N", and capped by bytes so a chatty
// dev server can run for days without growing the app.

export type Stream = 'stdout' | 'stderr'

export interface OutputLine {
  readonly seq: number
  readonly stream: Stream
  readonly text: string
}

export interface OutputSlice {
  readonly lines: OutputLine[]
  /** Pass as `since` next time to get only newer lines. */
  readonly next: number
  /** Lines older than the buffer's start that were dropped to stay under the cap. */
  readonly dropped: number
}

export const DEFAULT_OUTPUT_BYTES = 512 * 1024
const MAX_LINE_CHARS = 4000

// CSI sequences (colours, cursor moves) and OSC sequences (titles, hyperlinks).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// Dev servers announce themselves as e.g. "Local: http://localhost:5173/".
// 0.0.0.0 means "all interfaces"; a browser has to use a loopback name instead.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)]*)?/i

export function detectLocalUrl(line: string): string | undefined {
  const match = LOCAL_URL.exec(line)
  if (!match) return undefined
  return match[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '')
}

export interface OutputBuffer {
  /** Feeds a raw chunk; returns the complete lines it produced. */
  push(stream: Stream, chunk: string): OutputLine[]
  /** Emits any unterminated trailing text (call when the process exits). */
  flush(): OutputLine[]
  read(options?: { since?: number; tail?: number }): OutputSlice
}

export function createOutputBuffer(maxBytes: number = DEFAULT_OUTPUT_BYTES): OutputBuffer {
  const lines: OutputLine[] = []
  const partial: Record<Stream, string> = { stdout: '', stderr: '' }
  let bytes = 0
  let nextSeq = 1
  let dropped = 0

  const add = (stream: Stream, raw: string): OutputLine => {
    const clean = stripAnsi(raw).replace(/\r$/, '')
    // A progress bar rewrites its line with \r; keep only what the terminal would show last.
    const shown = clean.slice(clean.lastIndexOf('\r') + 1)
    const text = shown.length > MAX_LINE_CHARS ? `${shown.slice(0, MAX_LINE_CHARS)}…` : shown
    const line: OutputLine = { seq: nextSeq++, stream, text }
    lines.push(line)
    bytes += text.length + 1
    while (bytes > maxBytes && lines.length > 1) {
      const old = lines.shift()
      if (!old) break
      bytes -= old.text.length + 1
      dropped++
    }
    return line
  }

  return {
    push(stream, chunk) {
      const parts = (partial[stream] + chunk).split('\n')
      partial[stream] = parts.pop() ?? ''
      // Guard against a stream that never sends a newline.
      if (partial[stream].length > MAX_LINE_CHARS * 4) {
        parts.push(partial[stream])
        partial[stream] = ''
      }
      return parts.map((part) => add(stream, part))
    },
    flush() {
      const out: OutputLine[] = []
      for (const stream of ['stdout', 'stderr'] as const) {
        if (partial[stream]) out.push(add(stream, partial[stream]))
        partial[stream] = ''
      }
      return out
    },
    read({ since, tail } = {}) {
      let slice = since === undefined ? lines : lines.filter((line) => line.seq > since)
      if (tail !== undefined) slice = slice.slice(-tail)
      return { lines: [...slice], next: nextSeq - 1, dropped }
    },
  }
}
