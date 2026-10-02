import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
    return JSON.parse(readFileSync(file, 'utf8')) as ThreadMeta
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
      appendFileSync(join(dirOf(id), 'events.jsonl'), `${JSON.stringify(stored)}\n`)
      const md = markdownFor(event, stored.ts)
      if (md) appendFileSync(join(dirOf(id), 'messages.md'), md)
      return stored
    },
    events(id) {
      const file = join(dirOf(id), 'events.jsonl')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as StoredEvent)
    },
    transcriptPath(id) {
      return join(dirOf(id), 'messages.md')
    },
    remove(id) {
      rmSync(dirOf(id), { recursive: true, force: true })
    },
  }
}
