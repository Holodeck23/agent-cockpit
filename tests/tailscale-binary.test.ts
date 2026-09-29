import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tailscaleBinary } from '../server/remote/tailscale.ts'

describe('Tailscale discovery on another installation', () => {
  it('uses an executable on the user PATH before standard locations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-tail-bin-'))
    const binary = join(dir, 'tailscale')
    writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 })
    expect(tailscaleBinary(dir, ['/not-installed/tailscale'])).toBe(binary)
    chmodSync(binary, 0o600)
    expect(() => tailscaleBinary(dir, [])).toThrow('not installed')
  })

  it('falls back to an app binary but rejects a directory named tailscale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-tail-app-'))
    mkdirSync(join(dir, 'tailscale'))
    const app = join(dir, 'app-binary')
    writeFileSync(app, '#!/bin/sh\n', { mode: 0o700 })
    expect(tailscaleBinary(dir, [app])).toBe(app)
    expect(() => tailscaleBinary(dir, [])).toThrow('not installed')
  })
})
