// Find and replace in the file editor (Source and Document views): pure text helpers,
// unit-tested. The painting and editing live in components/EditorFindBar.tsx and its adapters.

/** Non-overlapping [start, end) offsets of `query` exactly as typed (spaces kept); case ignored unless `matchCase`. */
export function findIn(text: string, query: string, matchCase = false): Array<[number, number]> {
  if (!query) return []
  // Lower-casing a few characters (e.g. "İ") changes the text's length; offsets would drift, so match exactly then.
  const fold = !matchCase && text.toLowerCase().length === text.length
  const [haystack, needle] = fold ? [text.toLowerCase(), query.toLowerCase()] : [text, query]
  const found: Array<[number, number]> = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found.push([at, at + needle.length])
  return found
}

/** `text` with every range replaced by `replacement`; everything between stays exactly as it was. */
export function replaceAllIn(text: string, ranges: ReadonlyArray<readonly [number, number]>, replacement: string): string {
  let out = ''
  let from = 0
  for (const [start, end] of ranges) {
    out += text.slice(from, start) + replacement
    from = end
  }
  return out + text.slice(from)
}
