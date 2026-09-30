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

/** The user's text with file references pulled out, and the files it attaches. */
export function describeAttachments(text: string): { text: string; attachments: string[] } {
  const attachments: string[] = []
  // Also take one following space, so "Check @file:a and" reads "Check and".
  const rest = text.replace(/(^|\s)@file:(\S+)[ \t]?/g, (_match, lead: string, encoded: string) => {
    attachments.push(decodeReference(encoded) ?? encoded)
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
