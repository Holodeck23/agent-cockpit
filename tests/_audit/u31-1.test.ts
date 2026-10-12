import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'

// u31-1: `.activity-pane` is placed with `grid-row: 1 / -1`. `-1` is the last line of the EXPLICIT grid,
// and `.thread` declares three explicit rows (header, transcript, composer). ThreadView also renders
// `.chrome-connecting` (while running) or `.follow-ups` (when idle) as their own direct children, which
// pushes the Composer into an implicit fourth row. The pane then stops at the composer's top edge and
// leaves a blank rectangle beside the composer, then snaps to full height when the chips go away.
// CORRECT behaviour: with the pane open, it spans every row the conversation can occupy, including the
// implicit ones (checked in a real browser engine: the pane's bottom edge equals the conversation's).

const WEB = new URL('../../web/src/', import.meta.url)
// The order main.tsx imports the stylesheets in is the cascade order.
const SHEETS = [...readFileSync(new URL('main.tsx', WEB), 'utf8').matchAll(/^import '(\.\/[^']+\.css)'/gm)].map((m) => m[1]!)

/** The last declared value of each property for rules whose selector is exactly `selector` (top level only, not @media). */
function cascade(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const sheet of SHEETS) {
    postcss.parse(readFileSync(new URL(sheet, WEB), 'utf8')).walkRules((rule) => {
      if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return
      rule.walkDecls((decl) => { out.set(decl.prop, decl.value) })
    })
  }
  return out
}

/** Top-level tracks of a grid-template-rows value: `auto minmax(0, 1fr) auto` is three. */
function trackCount(value: string): number {
  let depth = 0, tracks = 0, inTrack = false
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    const space = depth === 0 && /\s/.test(ch)
    if (!space && !inTrack) tracks++
    inTrack = !space
  }
  return tracks
}

// ThreadView's direct children that take a row of their own, at most: the header, the transcript,
// ONE of the Chrome-connecting bar (running) and the follow-up chips (idle), and the composer.
const MOST_ROWS = 4

describe('the activity pane beside a conversation', () => {
  it('reaches the bottom of the conversation when follow-ups or the Chrome bar push the composer into an implicit row', () => {
    const explicit = trackCount((cascade('.thread.with-activity').get('grid-template-rows') ?? cascade('.thread').get('grid-template-rows'))!)
    const [start, end] = cascade('.activity-pane').get('grid-row')!.split('/').map((s) => s.trim())
    const first = Number(start)
    // `-1` is the last EXPLICIT line; `span N` counts from the start line and may run past the explicit rows.
    const endLine = end === '-1' ? explicit + 1 : end!.startsWith('span ') ? first + Number(end!.slice(5)) : Number(end)
    expect(first).toBe(1)
    expect(endLine - first).toBeGreaterThanOrEqual(MOST_ROWS)
  })
})
