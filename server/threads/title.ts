const MAX = 60
const MIN_BREAK = 30

/**
 * A conversation's title from its first message: one line, at most 60 characters, cut at a word
 * boundary with an ellipsis so a long first message never ends mid-word ("…check its log for err").
 */
export function titleFromText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= MAX) return line
  const room = line.slice(0, MAX - 1)
  const space = room.lastIndexOf(' ')
  // A very long first word has no good break: cut it where the room runs out.
  return `${(space >= MIN_BREAK ? room.slice(0, space) : room).replace(/[\s.,;:!?\-–—]+$/, '')}…`
}
