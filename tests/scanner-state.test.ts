import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../web/src/styles/scanner.css', import.meta.url), 'utf8')

describe('scanner state language', () => {
  it('keeps idle, working and needs-you selectors distinct', () => {
    expect(css).toMatch(/:not\(\.working\):not\(\.needs-input\).*scanner-placeholder/s)
    expect(css).toMatch(/\.composer-card\.working::after[\s\S]*animation:\s*scanner-edge/)
    expect(css).toMatch(/\.composer-card\.needs-input::after[\s\S]*animation:\s*scanner-needs/)
  })

  it('puts needs-you animation only inside the no-motion-preference block', () => {
    const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*)\n\}/)?.[1] ?? ''
    expect(motion).toContain('.composer-card.needs-input::after')
    expect(css.slice(0, css.indexOf('@media'))).not.toContain('animation: scanner-needs')
  })
})
