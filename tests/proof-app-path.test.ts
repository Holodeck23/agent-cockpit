import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A proof that builds its own path to the packaged app can drive one Cockpit while it launched
// another (proof:quit once sent its Quit to the default build, not COCKPIT_APP's). The packaged
// app's location lives only in scripts/lib/launch-app.ts; proofs use EXECUTABLE or APP_BUNDLE.
const scripts = new URL('../scripts/', import.meta.url)
const proofs = readdirSync(scripts).filter((name) => /^proof-.*\.ts$/.test(name))

describe('packaged proofs locate the app in one place', () => {
  it('finds the proof scripts', () => {
    expect(proofs.length).toBeGreaterThan(10)
  })

  it.each(proofs)('%s does not name release/mac-arm64/Cockpit.app', (name) => {
    const named = readFileSync(new URL(name, scripts), 'utf8').includes('release/mac-arm64/Cockpit.app')
    expect(named, 'use EXECUTABLE or APP_BUNDLE from scripts/lib/launch-app.ts').toBe(false)
  })
})
