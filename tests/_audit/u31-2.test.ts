import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'

// u31-2: `.file-tabs` first gets `overflow-x: auto`, then a later `.file-tabs { overflow: visible }`
// (so the Open tabs popover is not clipped) cancels it. The tabs are `flex: none` and `.file-tab-list` is
// `display: contents`, so nothing scrolls them: past a handful of open files they spill out of the strip,
// the whole editor pane grows a horizontal scrollbar, and the active tab and the Open tabs chevron (the
// only way to list every file) sit past the right edge.
// CORRECT behaviour: the tabs scroll inside their own box (`.file-tab-list`), while `.file-tabs` itself
// stays unclipped for the popover (checked in a real browser engine: with 12 tabs the editor pane has no
// horizontal overflow and the chevron stays inside it).

const WEB = new URL('../../web/src/', import.meta.url)
// The order main.tsx imports the stylesheets in is the cascade order.
const SHEETS = [...readFileSync(new URL('main.tsx', WEB), 'utf8').matchAll(/^import '(\.\/[^']+\.css)'/gm)].map((m) => m[1]!)

/** The last declared value of each property for rules whose selector is exactly `selector` (top level only, not @media). `overflow` is split into its two axes. */
function cascade(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const sheet of SHEETS) {
    postcss.parse(readFileSync(new URL(sheet, WEB), 'utf8')).walkRules((rule) => {
      if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return
      rule.walkDecls((decl) => {
        if (decl.prop === 'overflow') {
          const [x = 'visible', y = x] = decl.value.split(/\s+/)
          out.set('overflow-x', x); out.set('overflow-y', y)
        } else out.set(decl.prop, decl.value)
      })
    })
  }
  return out
}

const SCROLLS = ['auto', 'scroll']

describe('the open-files tab strip', () => {
  it('scrolls the tabs in their own box so they cannot spill out of the strip', () => {
    const list = cascade('.file-tab-list')
    expect(list.get('display')).not.toBe('contents')
    expect(SCROLLS).toContain(list.get('overflow-x'))
  })
  it('does not clip the Open tabs popover, which hangs below the strip', () => {
    const strip = cascade('.file-tabs')
    expect(strip.get('overflow-x') ?? 'visible').toBe('visible')
    expect(strip.get('overflow-y') ?? 'visible').toBe('visible')
  })
})
