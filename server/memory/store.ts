import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// Cross-conversation memory (U13): short dated entries Cockpit keeps in <root>/memory.json, never in
// a repository. Two scopes: one project (context, decisions) or everywhere (your preferences). Each
// entry says when it was made and where from: a conversation or you. Agents search it on demand
// (recall) and add to it only with your approval (remember); it is never pasted into every prompt.

export const MAX_MEMORY_CHARS = 1000
export const memoryScope = z.enum(['project', 'everywhere'])
export type MemoryScope = z.output<typeof memoryScope>
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('you') }),
  z.object({ kind: z.literal('conversation'), threadId: z.string().min(1).max(100) }),
])
const entrySchema = z.object({
  id: z.uuid(),
  scope: memoryScope,
  /** Set for project entries only. */
  projectPath: z.string().optional(),
  text: z.string().trim().min(1).max(MAX_MEMORY_CHARS),
  source: sourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MemoryEntry = z.output<typeof entrySchema>
export type MemorySource = z.output<typeof sourceSchema>

export interface MemoryStore {
  /** This project's entries and the everywhere ones, newest first. */
  list(projectPath: string): MemoryEntry[]
  add(input: { scope: MemoryScope; projectPath: string; text: string; source: MemorySource }): MemoryEntry
  update(id: string, text: string): MemoryEntry
  remove(id: string): void
  /** Forgets this project's entries; everywhere ones stay. Returns how many went. */
  clearProject(projectPath: string): number
  /** Entries visible from the project that share words with the query, best first; newest when the query is empty. */
  search(projectPath: string, query: string, limit?: number): MemoryEntry[]
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []

export function createMemoryStore(root: string): MemoryStore {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const file = join(root, 'memory.json')
  const read = (): MemoryEntry[] => {
    if (!existsSync(file)) return []
    try {
      return z.array(entrySchema).parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return []
    }
  }
  const write = (rows: readonly MemoryEntry[]): void => {
    writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const visible = (projectPath: string): MemoryEntry[] =>
    read().filter((e) => e.scope === 'everywhere' || e.projectPath === projectPath).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return {
    list: visible,
    add({ scope, projectPath, text, source }) {
      const now = new Date().toISOString()
      const entry = entrySchema.parse({ id: randomUUID(), scope, ...(scope === 'project' ? { projectPath } : {}), text, source, createdAt: now, updatedAt: now })
      write([...read(), entry])
      return entry
    },
    update(id, text) {
      const rows = read()
      const old = rows.find((e) => e.id === id)
      if (!old) throw new Error('Unknown memory')
      const next = entrySchema.parse({ ...old, text, updatedAt: new Date().toISOString() })
      write(rows.map((e) => (e.id === id ? next : e)))
      return next
    },
    remove(id) {
      const rows = read()
      if (!rows.some((e) => e.id === id)) throw new Error('Unknown memory')
      write(rows.filter((e) => e.id !== id))
    },
    clearProject(projectPath) {
      const rows = read()
      const kept = rows.filter((e) => !(e.scope === 'project' && e.projectPath === projectPath))
      write(kept)
      return rows.length - kept.length
    },
    search(projectPath, query, limit = 8) {
      const wanted = new Set(words(query))
      const all = visible(projectPath)
      if (wanted.size === 0) return all.slice(0, limit)
      return all
        .map((entry) => ({ entry, score: new Set(words(entry.text).filter((w) => wanted.has(w))).size }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
        .slice(0, limit)
        .map((m) => m.entry)
    },
  }
}

/** What `recall` hands the agent: each entry with its date and origin, under a reminder that memory ages. */
export function recallText(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return 'Nothing in Cockpit memory matches. Do not assume anything was decided before.'
  return [
    'From Cockpit memory. These are notes from earlier conversations or from the user; they may be out of date, so check them against the project before relying on them.',
    ...entries.map((e) => `- [${e.updatedAt.slice(0, 10)}, ${e.scope === 'everywhere' ? 'everywhere' : 'this project'}, from ${e.source.kind === 'you' ? 'the user' : 'a conversation'}] ${e.text}`),
  ].join('\n')
}
