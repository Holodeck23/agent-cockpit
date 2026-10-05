import { describe, expect, it } from 'vitest'
import { launchReason, visibleName } from '../server/files/visible-name.ts'

// A repository can carry `Invoice-<U+202E>fdp.command`, which reads as `Invoice-dnammoc.pdf` (M5).
const RLO = String.fromCodePoint(0x202e)
const ZWSP = String.fromCodePoint(0x200b)

describe('file names as shown', () => {
  it('makes characters that reorder or hide text visible', () => {
    expect(visibleName(`Invoice-${RLO}fdp.command`)).toBe('Invoice-⟨U+202E⟩fdp.command')
    expect(visibleName(`a${ZWSP}b\nc`)).toBe('a⟨U+200B⟩b⟨U+000A⟩c')
    expect(visibleName('notes (final) – v2.md')).toBe('notes (final) – v2.md')
  })

  it('asks before opening what macOS would run, and not for documents', () => {
    expect(launchReason(`/p/Invoice-${RLO}fdp.command`, 0o644)).toMatch(/\.command/)
    expect(launchReason('/p/Run.TERMINAL', 0o644)).toMatch(/\.terminal/)
    expect(launchReason('/p/setup', 0o755)).toMatch(/executable/)
    expect(launchReason('/p/report.pdf', 0o644)).toBeUndefined()
    expect(launchReason('/p/README.md', 0o644)).toBeUndefined()
  })
})
