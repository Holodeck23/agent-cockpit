// Find in a conversation: pure matching, unit-tested. The DOM side is in components/FindBar.tsx.

/** Case-insensitive, non-overlapping [start, end) offsets of `query` in `text`. */
export function findRanges(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const haystack = text.toLowerCase()
  const found: Array<[number, number]> = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    found.push([at, at + needle.length])
  }
  return found
}

/** The next (+1) or previous (-1) match, wrapping; -1 when there is none. */
export function stepIndex(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}
