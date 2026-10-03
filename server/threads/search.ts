// History search over every message (A9): each conversation's transcript (messages.md, plain
// text kept beside its events) must contain every word of the query, case-insensitively.
import { existsSync, readFileSync } from 'node:fs'
import type { ThreadStore } from './store.ts'

export const MAX_QUERY = 200
const MAX_HITS = 200
const RADIUS = 50

export interface SearchHit { readonly id: string; readonly excerpt: string }

export function searchThreads(store: ThreadStore, query: string, projectPath?: string): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.join('').length < 2) return []
  const hits: SearchHit[] = []
  for (const meta of store.list()) {
    if (projectPath && meta.projectPath !== projectPath) continue
    const file = store.transcriptPath(meta.id)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const lower = text.toLowerCase()
    if (!words.every((word) => lower.includes(word))) continue
    const at = lower.indexOf(words[0]!)
    const from = Math.max(0, at - RADIUS)
    const to = Math.min(text.length, at + words[0]!.length + RADIUS)
    const excerpt = `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`
    hits.push({ id: meta.id, excerpt })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}
