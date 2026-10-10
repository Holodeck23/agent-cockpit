import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPackageTree } from '../scripts/lib/package-hash.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-package-hash-'))
  dirs.push(root)
  mkdirSync(join(root, 'Contents'))
  writeFileSync(join(root, 'Contents', 'app.asar'), 'one')
  symlinkSync('app.asar', join(root, 'Contents', 'current'))
  return root
}

describe('package tree hash', () => {
  it('is stable for the same package and changes with bytes, modes, or symlink targets', () => {
    const root = fixture()
    const original = hashPackageTree(root)
    expect(hashPackageTree(root)).toBe(original)
    writeFileSync(join(root, 'Contents', 'app.asar'), 'two')
    expect(hashPackageTree(root)).not.toBe(original)
    const bytesChanged = hashPackageTree(root)
    chmodSync(join(root, 'Contents', 'app.asar'), 0o755)
    expect(hashPackageTree(root)).not.toBe(bytesChanged)
  })
})
