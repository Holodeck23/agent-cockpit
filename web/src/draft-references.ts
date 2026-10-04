// The references in a composer draft, as the context picker's chips show them. The draft
// text stays the single source of truth: chips are read from it and edit it. Pure, so it
// is unit-tested without a browser.
import { decodeReference, FILE_REFERENCE, parseFileReference, referenceLabel, WORKFLOW_REFERENCE } from '../../server/files/references.ts'

export type ReferenceKind = 'file' | 'workflow'

export interface DraftReference {
  readonly kind: ReferenceKind
  /** As written after the colon: an encoded path or a workflow name. */
  readonly reference: string
  /** What the chip says: the decoded file path or the workflow name. */
  readonly label: string
  /** More than 1 means the same thing is attached twice. */
  readonly count: number
}

export const tokenFor = (kind: ReferenceKind, reference: string): string => `@${kind}:${reference}`
export const fileReference = (path: string): string => encodeURIComponent(path)

export function referencesIn(text: string): DraftReference[] {
  const found = new Map<string, { kind: ReferenceKind; reference: string; label: string; count: number }>()
  const add = (kind: ReferenceKind, reference: string, label: string): void => {
    const key = tokenFor(kind, reference)
    const existing = found.get(key)
    found.set(key, existing ? { ...existing, count: existing.count + 1 } : { kind, reference, label, count: 1 })
  }
  for (const [, , encoded] of text.matchAll(FILE_REFERENCE)) if (encoded) { const ref = parseFileReference(encoded); add('file', encoded, ref ? referenceLabel(ref) : decodeReference(encoded) ?? encoded) }
  for (const [, , name] of text.matchAll(WORKFLOW_REFERENCE)) if (name) add('workflow', name, name)
  return [...found.values()]
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tokenPattern = (token: string): RegExp => new RegExp(`(^|\\s)${escape(token)}(?=\\s|$)`, 'g')

export const hasReference = (text: string, token: string): boolean => tokenPattern(token).test(text)

/** Adds a reference at the end, once; the draft is unchanged if it is already there. */
export function addReference(text: string, token: string): string {
  if (hasReference(text, token)) return text
  return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${token} `
}

/** Removes every copy of a reference, and the space after each. */
export function removeReference(text: string, token: string): string {
  return text.replace(new RegExp(`(^|\\s)${escape(token)}(?=\\s|$)[ \\t]?`, 'g'), '$1').replace(/[ \t]+\n/g, '\n').replace(/^[ \t]+/, '')
}

/** An `@word` being typed in the draft: where its @ sits and what follows it so far. */
export interface Mention { readonly start: number; readonly query: string }

const MAX_MENTION = 80

/**
 * The @word the caret is in, if any. The @ must start a word (so mail addresses stay quiet),
 * and a written token (`@file:…`) or a finished word is not a mention.
 */
export function mentionAt(text: string, caret: number): Mention | undefined {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@:]*)$/.exec(before)
  if (!match) return undefined
  const query = match[2] ?? ''
  if (query.length > MAX_MENTION) return undefined
  return { start: caret - query.length - 1, query }
}

/** Replaces the typed @word with a reference token followed by a space; returns where the caret goes. */
export function completeMention(text: string, mention: Mention, token: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length
  const rest = text.slice(end)
  const next = `${text.slice(0, mention.start)}${token}${/^\s/.test(rest) ? '' : ' '}${rest}`
  return { text: next, caret: mention.start + token.length + 1 }
}
