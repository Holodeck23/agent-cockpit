import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensurePrivateDir, writeFileAtomic } from '../server/files/atomic.ts'

describe('writing Cockpit state (L10)', () => {
  it('replaces a file in one step, privately, and leaves nothing beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-atomic-'))
    const file = join(dir, 'remote.json')
    writeFileAtomic(file, '{"a":1}')
    writeFileAtomic(file, '{"a":2}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['remote.json'])
  })

  it('never writes through a symlink left at the old predictable temp name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-atomic-'))
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'untouched')
    symlinkSync(victim, join(dir, 'remote.json.tmp'))
    writeFileAtomic(join(dir, 'remote.json'), '{"a":1}')
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
  })

  it('tightens a state folder that already existed with loose permissions', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cockpit-atomic-')), 'state')
    mkdirSync(dir, { mode: 0o777 })
    chmodSync(dir, 0o777)
    ensurePrivateDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    ensurePrivateDir(join(dir, 'new'))
    expect(existsSync(join(dir, 'new'))).toBe(true)
  })
})
