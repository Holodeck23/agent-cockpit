// Pure helpers for scripts/release.ts: version checks and the version-bearing text in the
// README and landing page. Release-specific prose is never rewritten; staleMentions lists it.

export type Version = readonly [number, number, number]

export function parseVersion(text: string): Version | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Link and label patterns that always name the current release; `V` marks each version slot. */
const PATTERNS: readonly string[] = [
  'releases/download/vV/Cockpit-V-arm64\\.dmg',
  'releases/download/vV/SHA256SUMS',
  'releases/tag/vV(?![\\d.])',
  '\\bvV is ready to try',
  'Cockpit V / Prerelease',
  '<span class="eyebrow">/ V</span>',
]

export function bumpReleaseLinks(text: string, from: string, to: string): string {
  return PATTERNS.reduce(
    (out, pattern) => out.replace(new RegExp(pattern.replaceAll('V', escape(from)), 'g'), (match) => match.replaceAll(from, to)),
    text,
  )
}

/** Lines that still name `version` after the bump: release prose for a human to rewrite. */
export function staleMentions(text: string, version: string): { line: number; text: string }[] {
  const pattern = new RegExp(`(?<![\\d.])${escape(version)}(?![\\d])(?!\\.\\d)`)
  return text.split('\n').flatMap((line, index) => (pattern.test(line) ? [{ line: index + 1, text: line.trim() }] : []))
}

export function landingSizeLabel(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

export function withLandingSize(text: string, bytes: number): string {
  return text.replace(/(· DMG · )\d+(?:\.\d)? MB/g, `$1${landingSizeLabel(bytes)}`)
}
