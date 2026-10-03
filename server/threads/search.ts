// History search over every message (A9): what you and the agents wrote (not tool output or
// notes) must contain every word of the query, case-insensitively, across the conversation.
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
    const texts = store.events(meta.id).flatMap(({ event }) => (event.kind === 'user_text' || event.kind === 'assistant_text' ? [event.text] : []))
    const all = texts.join('\n').toLowerCase()
    if (!words.every((word) => all.includes(word))) continue
    // The excerpt is from the first message holding the first word.
    const text = texts.find((t) => t.toLowerCase().includes(words[0]!)) ?? ''
    const at = text.toLowerCase().indexOf(words[0]!)
    const from = Math.max(0, at - RADIUS)
    const to = Math.min(text.length, at + words[0]!.length + RADIUS)
    hits.push({ id: meta.id, excerpt: `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}` })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}
