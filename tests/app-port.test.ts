import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAppPort, writeAppPort } from '../electron/app-port.ts'

describe('app port file', () => {
  it('round-trips a port and creates the folder', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-port-')), 'nested', 'app-port')
    writeAppPort(file, 51234)
    expect(readAppPort(file)).toBe(51234)
  })

  it('ignores a missing, garbled or privileged value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-port-'))
    expect(readAppPort(join(dir, 'missing'))).toBeUndefined()
    for (const text of ['nope', '80', '70000', '51234.5']) {
      writeFileSync(join(dir, 'p'), text)
      expect(readAppPort(join(dir, 'p'))).toBeUndefined()
    }
  })
})
