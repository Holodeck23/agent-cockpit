import { describe, expect, it } from 'vitest'
import { bumpReleaseLinks, isNewerVersion, landingSizeLabel, parseVersion, staleMentions, withLandingSize } from '../scripts/lib/release.ts'

describe('parseVersion', () => {
  it('accepts plain x.y.z only', () => {
    expect(parseVersion('0.1.4')).toEqual([0, 1, 4])
    expect(parseVersion('v0.1.4')).toBeUndefined()
    expect(parseVersion('0.1')).toBeUndefined()
    expect(parseVersion('0.1.4-beta')).toBeUndefined()
    expect(parseVersion('01.1.4')).toBeUndefined()
  })
})

describe('isNewerVersion', () => {
  it('compares numerically, not as text', () => {
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.1.13')).toBe(true)
    expect(isNewerVersion('0.1.3', '0.1.3')).toBe(false)
    expect(isNewerVersion('0.1.2', '0.1.3')).toBe(false)
  })
})

describe('bumpReleaseLinks', () => {
  const page = [
    '<a class="release-chip" href="#release"><i class="dot"></i> v0.1.3 is ready to try</a>',
    '<span class="eyebrow">Cockpit 0.1.3 / Prerelease</span>',
    '<a id="download" href="https://github.com/Holodeck23/agent-cockpit/releases/download/v0.1.3/Cockpit-0.1.3-arm64.dmg">Download</a>',
    '<a href="https://github.com/Holodeck23/agent-cockpit/releases/tag/v0.1.3">Release notes</a>',
    '<a href="https://github.com/Holodeck23/agent-cockpit/releases/download/v0.1.3/SHA256SUMS">SHA-256</a>',
    '<a class="brand" href="#main">Cockpit <span class="eyebrow">/ 0.1.3</span></a>',
    '<p>v0.1.3 adds Check for Updates.</p>',
  ].join('\n')

  it('moves every release link and version label to the new version', () => {
    const out = bumpReleaseLinks(page, '0.1.3', '0.1.4')
    expect(out).toContain('releases/download/v0.1.4/Cockpit-0.1.4-arm64.dmg')
    expect(out).toContain('releases/tag/v0.1.4')
    expect(out).toContain('releases/download/v0.1.4/SHA256SUMS')
    expect(out).toContain('v0.1.4 is ready to try')
    expect(out).toContain('Cockpit 0.1.4 / Prerelease')
    expect(out).toContain('<span class="eyebrow">/ 0.1.4</span>')
  })

  it('moves generic mentions: the bare DMG name, its tag and "the vX prerelease"', () => {
    const readme = 'find the latest [`Cockpit-0.1.3-arm64.dmg`](x) from tag `v0.1.3`. Get the v0.1.3 prerelease.'
    expect(bumpReleaseLinks(readme, '0.1.3', '0.1.4')).toBe('find the latest [`Cockpit-0.1.4-arm64.dmg`](x) from tag `v0.1.4`. Get the v0.1.4 prerelease.')
  })

  it('leaves release-specific prose alone so a human rewrites it', () => {
    const out = bumpReleaseLinks(page, '0.1.3', '0.1.4')
    expect(out).toContain('<p>v0.1.3 adds Check for Updates.</p>')
    expect(staleMentions(out, '0.1.3')).toEqual([{ line: 7, text: '<p>v0.1.3 adds Check for Updates.</p>' }])
  })

  it('does not touch a longer version that starts with the old one', () => {
    const text = 'releases/tag/v0.1.30 and releases/tag/v0.1.3'
    expect(bumpReleaseLinks(text, '0.1.3', '0.1.4')).toBe('releases/tag/v0.1.30 and releases/tag/v0.1.4')
    expect(staleMentions('v0.1.30 only', '0.1.3')).toEqual([])
  })

  it('treats the dots in a version literally', () => {
    expect(bumpReleaseLinks('releases/tag/v0x1x3', '0.1.3', '0.1.4')).toBe('releases/tag/v0x1x3')
  })
})

describe('landing size', () => {
  it('formats bytes as decimal megabytes with one decimal, like Finder', () => {
    expect(landingSizeLabel(133_451_174)).toBe('133.5 MB')
    expect(landingSizeLabel(133_400_000)).toBe('133.4 MB')
  })

  it('rewrites only the DMG size line', () => {
    const line = '<p class="micro">Apple silicon (M1+) · DMG · 133.4 MB<br>Not notarized.</p>'
    expect(withLandingSize(line, 140_000_000)).toBe('<p class="micro">Apple silicon (M1+) · DMG · 140.0 MB<br>Not notarized.</p>')
    expect(withLandingSize('no size here', 140_000_000)).toBe('no size here')
  })
})
