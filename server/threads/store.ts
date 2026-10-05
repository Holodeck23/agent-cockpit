import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '../agents/types.ts'
import type { StoredEvent, ThreadMeta } from './types.ts'
import { withAttachmentNote } from '../files/references.ts'
import { StoreReadError } from '../state/read-error.ts'
import { ensurePrivateDir, writeFileAtomic } from '../files/atomic.ts'

// File-first storage, one folder per thread, outside the repo:
//   <root>/threads/<id>/meta.json     current metadata (atomic rewrite)
//   <root>/threads/<id>/events.jsonl  append-only normalized events
//   <root>/threads/<id>/messages.md   human/agent-readable transcript

const ID_PATTERN = /^[0-9a-f-]{36}$/

/**
 * A crash, a power cut or a full disk can leave half a line at the end of events.jsonl, or a
 * meta.json that does not parse. One such file must not take every conversation down with it:
 * the conversation list reads them all. Damaged lines are skipped and reported once per file.
 */
const reported = new Set<string>()
function reportOnce(file: string, what: string): void {
  if (reported.has(file)) return
  reported.add(file)
  console.error(`[cockpit] ${what}: ${file}`)
}

function parseEvents(file: string, text: string): StoredEvent[] {
  const events: StoredEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as StoredEvent
      if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'string' && parsed.event && typeof parsed.event === 'object') events.push(parsed)
      else skipped++
    } catch {
      skipped++
    }
  }
  if (skipped > 0) reportOnce(file, `skipped ${skipped} damaged line${skipped === 1 ? '' : 's'} in a conversation log`)
  return events
}

/** True when the file is empty or its last byte is a newline, so an append starts a fresh line. */
function endsWithNewline(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    if (size === 0) return true
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally { closeSync(fd) }
}

export interface ThreadStore {
  readonly root: string
  create(meta: ThreadMeta): ThreadMeta
  list(): ThreadMeta[]
  get(id: string): ThreadMeta | undefined
  update(id: string, patch: Partial<Omit<ThreadMeta, 'id' | 'createdAt'>>): ThreadMeta
  /** `ts` keeps an imported event's original time; new events are stamped now. */
  append(id: string, event: NormalizedEvent, ts?: string): StoredEvent
  events(id: string): StoredEvent[]
  transcriptPath(id: string): string
  /** Deletes the conversation's folder: metadata, events and transcript. */
  remove(id: string): void
}

export function defaultRoot(): string {
  return process.env.COCKPIT_HOME ?? join(homedir(), '.agent-cockpit')
}

function markdownFor(event: NormalizedEvent, ts: string): string | undefined {
  if (event.kind === 'user_text') return `\n## ${event.fromConversation ? `From conversation: ${event.fromConversation.title.replace(/[\r\n]/g, ' ')} (${event.fromConversation.id})` : 'You'} · ${ts}\n\n${withAttachmentNote(event.text)}\n`
  if (event.kind === 'assistant_text') return `\n## Agent · ${ts}\n\n${event.text}\n`
  if (event.kind === 'tool_use') return `\n> tool: ${event.name}\n`
  return undefined
}

/** `cacheBudget`: log bytes kept parsed in memory across conversations (tests set it small). */
export function createThreadStore(root: string = defaultRoot(), cacheBudget = 64_000_000): ThreadStore {
  const threadsDir = join(root, 'threads')
  ensurePrivateDir(root)
  ensurePrivateDir(threadsDir)

  const dirOf = (id: string): string => {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid thread id: ${id}`)
    return join(threadsDir, id)
  }
  const writeMeta = (meta: ThreadMeta): void => {
    const file = join(dirOf(meta.id), 'meta.json')
    writeFileAtomic(file, JSON.stringify(meta, null, 2))
  }
  const readMeta = (id: string): ThreadMeta | undefined => {
    const file = join(dirOf(id), 'meta.json')
    if (!existsSync(file)) return undefined
    let meta: ThreadMeta | undefined
    try { meta = JSON.parse(readFileSync(file, 'utf8')) as ThreadMeta } catch { /* reported below */ }
    if (meta && typeof meta === 'object' && meta.id === id && typeof meta.updatedAt === 'string') return meta
    // Left on disk untouched; the list skips it and opening it reports the damage (ID-02).
    reportOnce(file, 'a conversation\'s meta.json is damaged and was left out')
    throw new StoreReadError('UNREADABLE', file, 'not valid conversation metadata')
  }
  /**
   * Parsed events per thread, read incrementally. Status, the list's summaries and every streamed
   * token used to re-read and re-parse the whole log: on an 8 MB conversation that was ~28 ms per
   * token on the Electron main thread. The log only grows, so after the first read only the bytes
   * appended since are parsed. `consumed` stops at the last newline, so half a line is read again
   * once it is complete. A log that shrank or was replaced is read whole again.
   */
  // Least recently read first. The conversation list reads every conversation, so without a bound
  // every log ever opened would stay parsed in the main process; past the budget the oldest are
  // dropped and read whole again when next needed.
  const parsed = new Map<string, { ino: number; consumed: number; events: StoredEvent[] }>()
  let cachedBytes = 0
  const remember = (id: string, entry: { ino: number; consumed: number; events: StoredEvent[] }): void => {
    const previous = parsed.get(id)
    if (previous) { cachedBytes -= previous.consumed; parsed.delete(id) }
    parsed.set(id, entry)
    cachedBytes += entry.consumed
    for (const [oldest, old] of parsed) {
      if (cachedBytes <= cacheBudget || oldest === id) break
      parsed.delete(oldest)
      cachedBytes -= old.consumed
    }
  }
  const forget = (id: string): void => {
    const previous = parsed.get(id)
    if (previous) { cachedBytes -= previous.consumed; parsed.delete(id) }
  }
  const readEvents = (id: string): StoredEvent[] => {
    const file = join(dirOf(id), 'events.jsonl')
    let stat: { ino: number; size: number }
    try { stat = statSync(file) } catch { forget(id); return [] }
    let entry = parsed.get(id)
    if (!entry || entry.ino !== stat.ino || stat.size < entry.consumed) entry = { ino: stat.ino, consumed: 0, events: [] }
    if (stat.size > entry.consumed) {
      const fd = openSync(file, 'r')
      try {
        const chunk = Buffer.alloc(stat.size - entry.consumed)
        let read = 0
        while (read < chunk.length) {
          const count = readSync(fd, chunk, read, chunk.length - read, entry.consumed + read)
          if (!count) break
          read += count
        }
        const end = chunk.lastIndexOf(0x0a, read - 1)
        if (end >= 0) {
          // A newline byte never occurs inside a UTF-8 sequence, so complete lines decode safely.
          entry = { ...entry, consumed: entry.consumed + end + 1, events: entry.events.concat(parseEvents(file, chunk.subarray(0, end + 1).toString('utf8'))) }
        }
      } finally { closeSync(fd) }
    }
    remember(id, entry)
    return entry.events
  }

  return {
    root,
    create(meta) {
      mkdirSync(dirOf(meta.id), { recursive: true, mode: 0o700 })
      writeMeta(meta)
      writeFileSync(join(dirOf(meta.id), 'messages.md'), `# ${meta.title}\n\nProject: ${meta.projectPath}\n`)
      return meta
    },
    list() {
      return readdirSync(threadsDir)
        .filter((name) => ID_PATTERN.test(name))
        .flatMap((id) => {
          // One damaged conversation must not hide the rest; opening it reports the damage.
          try {
            const meta = readMeta(id)
            return meta ? [meta] : []
          } catch (error) {
            console.warn('[cockpit]', error instanceof Error ? error.message : error)
            return []
          }
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    get: readMeta,
    update(id, patch) {
      const current = readMeta(id)
      if (!current) throw new Error(`Unknown thread ${id}`)
      const next: ThreadMeta = { ...current, ...patch, updatedAt: new Date().toISOString() }
      writeMeta(next)
      return next
    },
    append(id, event, ts) {
      const stored: StoredEvent = { ts: ts ?? new Date().toISOString(), event }
      const file = join(dirOf(id), 'events.jsonl')
      // Appending after half a line (a crash, a write cut short by a full disk) would join the new
      // event to it and lose both. Checked on every append: one byte, once per stored event.
      const lead = existsSync(file) && !endsWithNewline(file) ? '\n' : ''
      appendFileSync(file, `${lead}${JSON.stringify(stored)}\n`)
      const md = markdownFor(event, stored.ts)
      if (md) appendFileSync(join(dirOf(id), 'messages.md'), md)
      return stored
    },
    events(id) {
      // A copy: callers may hold on to it while more events arrive.
      return readEvents(id).slice()
    },
    transcriptPath(id) {
      return join(dirOf(id), 'messages.md')
    },
    remove(id) {
      forget(id)
      rmSync(dirOf(id), { recursive: true, force: true })
    },
  }
}
