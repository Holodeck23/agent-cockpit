// Writes a rich-edited Markdown document back without reformatting what was not edited.
// Every top-level block keeps its original source text unless it changed; only new or
// edited blocks are serialised. Pure and generic over the block type, so it is unit-tested
// without an editor.

export interface SourceBlock {
  readonly start: number
  readonly end: number
}

export interface SpliceInput<Block> {
  /** The Markdown the document view started from (without any front matter). */
  readonly source: string
  /** Where each original top-level block sits in `source`, in order. */
  readonly ranges: readonly SourceBlock[]
  readonly original: readonly Block[]
  readonly current: readonly Block[]
  readonly same: (a: Block, b: Block) => boolean
  /** Markdown for one new or edited block; `replaces` is the original block it stands in for, if any. */
  readonly serialize: (block: Block, replaces?: number) => string
}

/** Longest common subsequence of unchanged blocks: current index → original index. */
export function matchBlocks<Block>(original: readonly Block[], current: readonly Block[], same: (a: Block, b: Block) => boolean): Map<number, number> {
  const n = original.length
  const m = current.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = same(original[i]!, current[j]!) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const matched = new Map<number, number>()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (same(original[i]!, current[j]!)) { matched.set(j, i); i += 1; j += 1 }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
    else j += 1
  }
  return matched
}

export function spliceMarkdown<Block>({ source, ranges, original, current, same, serialize }: SpliceInput<Block>): string {
  if (ranges.length !== original.length) throw new Error('Every original block needs its source range')
  const matched = matchBlocks(original, current, same)
  const first = ranges[0]
  const last = ranges.at(-1)
  let out = first ? source.slice(0, first.start) : ''
  let previous: number | undefined // the original block the last written block stands for, if any
  let slot = 0 // the next original an edited block may stand in for
  const kept = new Set(matched.values())
  current.forEach((block, j) => {
    const at = matched.get(j)
    // An edited block takes the place of the next original that was not kept, so it keeps that
    // block's spacing and can reuse its style.
    const replaces = at === undefined && slot < original.length && !kept.has(slot) ? slot : undefined
    const stands = at ?? replaces
    if (j > 0) {
      const before = previous
      out += before !== undefined && stands === before + 1 ? source.slice(ranges[before]!.end, ranges[stands]!.start) : '\n\n'
    }
    out += at === undefined ? serialize(block, replaces).replace(/\n+$/, '') : source.slice(ranges[at]!.start, ranges[at]!.end)
    if (stands !== undefined) slot = stands + 1
    previous = stands
  })
  if (current.length === 0) return out
  const endsOriginal = last !== undefined && previous === ranges.length - 1
  return out + (endsOriginal ? source.slice(last.end) : '\n')
}
