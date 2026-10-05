import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '../agents/types.ts'
import type { StoredEvent, ThreadMeta } from './types.ts'
import { withAttachmentNote } from '../files/references.ts'

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

export function createThreadStore(root: string = defaultRoot()): ThreadStore {
  const threadsDir = join(root, 'threads')
  mkdirSync(threadsDir, { recursive: true, mode: 0o700 })

  const dirOf = (id: string): string => {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid thread id: ${id}`)
    return join(threadsDir, id)
  }
  const writeMeta = (meta: ThreadMeta): void => {
    const file = join(dirOf(meta.id), 'meta.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  const readMeta = (id: string): ThreadMeta | undefined => {
    const file = join(dirOf(id), 'meta.json')
    if (!existsSync(file)) return undefined
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8')) as ThreadMeta
      if (meta && typeof meta === 'object' && meta.id === id && typeof meta.updatedAt === 'string') return meta
    } catch {
      // reported below
    }
    // Left on disk untouched, so nothing is lost; the conversation is just not listed.
    reportOnce(file, 'a conversation\'s meta.json is damaged and was left out')
    return undefined
  }
  // Threads whose log has been checked for a half-written last line since this process started.
  const checkedEnds = new Set<string>()

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
          const meta = readMeta(id)
          return meta ? [meta] : []
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
      // Appending after half a line would join the new event to it and lose both.
      const lead = !checkedEnds.has(id) && existsSync(file) && !endsWithNewline(file) ? '\n' : ''
      try {
        appendFileSync(file, `${lead}${JSON.stringify(stored)}\n`)
      } catch (error) {
        // A write cut short (a full disk) may itself leave half a line: check again next time.
        checkedEnds.delete(id)
        throw error
      }
      checkedEnds.add(id)
      const md = markdownFor(event, stored.ts)
      if (md) appendFileSync(join(dirOf(id), 'messages.md'), md)
      return stored
    },
    events(id) {
      const file = join(dirOf(id), 'events.jsonl')
      if (!existsSync(file)) return []
      return parseEvents(file, readFileSync(file, 'utf8'))
    },
    transcriptPath(id) {
      return join(dirOf(id), 'messages.md')
    },
    remove(id) {
      checkedEnds.delete(id)
      rmSync(dirOf(id), { recursive: true, force: true })
    },
  }
}
