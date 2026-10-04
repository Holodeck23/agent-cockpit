// Message references (`@file:`, `@workflow:`) are only recognised at the start of a
// token, so "a@file:x" or an email address in normal text is left alone.
// Pure module: the web page imports it to draw attachments.

/** A reference the user can fix (unknown file, bad encoding, too many). Maps to HTTP 400. */
export class MessageReferenceError extends Error {}

/** Files one message may attach; the composer's picker and the server share it. */
export const MAX_ATTACHED_FILES = 8

export const FILE_REFERENCE = /(^|\s)@file:(\S+)/g
export const WORKFLOW_REFERENCE = /(^|\s)@workflow:([a-z0-9]+(?:-[a-z0-9]+)*)/g

/** Decodes an encoded reference path, or undefined when the encoding is malformed. */
export function decodeReference(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/** A file reference: the whole file, or lines `line`…`endLine` of it. */
export interface FileReference { readonly path: string; readonly line?: number; readonly endLine?: number }

// A range follows the encoded path as #L3 or #L3-L7; an encoded path never holds a bare "#".
const RANGE = /#L(\d+)(?:-L(\d+))?$/

/** Reads what follows "@file:"; undefined when the encoding or the range is not valid. */
export function parseFileReference(encoded: string): FileReference | undefined {
  const range = RANGE.exec(encoded)
  const path = decodeReference(range ? encoded.slice(0, range.index) : encoded)
  if (path === undefined || !path) return undefined
  if (!range) return { path }
  const line = Number(range[1])
  const end = range[2] === undefined ? line : Number(range[2])
  if (!(line >= 1) || end < line) return undefined
  return end > line ? { path, line, endLine: end } : { path, line }
}

/** The token a draft holds: "@file:src%2Fa.ts", or with lines "@file:src%2Fa.ts#L3-L7". */
export function fileReferenceToken({ path, line, endLine }: FileReference): string {
  return `@file:${encodeURIComponent(path)}${line ? `#L${line}${endLine && endLine > line ? `-L${endLine}` : ''}` : ''}`
}

/** How a reference reads in chips and transcripts: "src/a.ts" or "src/a.ts:3-7". */
export function referenceLabel({ path, line, endLine }: FileReference): string {
  return line ? `${path}:${line}${endLine && endLine > line ? `-${endLine}` : ''}` : path
}

/** A label back into its file and lines (a file name holding ":<digits>" at its end reads as a range). */
export function labelTarget(label: string): FileReference {
  const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(label)
  if (!match) return { path: label }
  const line = Number(match[2])
  const end = match[3] === undefined ? line : Number(match[3])
  return end > line ? { path: match[1]!, line, endLine: end } : { path: match[1]!, line }
}

/** The user's text with file references pulled out, and the files it attaches. */
export function describeAttachments(text: string): { text: string; attachments: string[] } {
  const attachments: string[] = []
  // Also take one following space, so "Check @file:a and" reads "Check and".
  const rest = text.replace(/(^|\s)@file:(\S+)[ \t]?/g, (_match, lead: string, encoded: string) => {
    const reference = parseFileReference(encoded)
    attachments.push(reference ? referenceLabel(reference) : decodeReference(encoded) ?? encoded)
    return lead
  })
  return { text: rest.replace(/[ \t]+\n/g, '\n').trim(), attachments }
}

/** One-line form for transcripts and handoffs: "text (Attached: a.ts, b.md)". */
export function withAttachmentNote(text: string): string {
  const { text: body, attachments } = describeAttachments(text)
  if (attachments.length === 0) return text
  const note = `Attached: ${attachments.join(', ')}`
  return body ? `${body}\n${note}` : note
}
