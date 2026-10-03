import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectFolder } from '../electron/new-project.ts'

describe('New project', () => {
  it('creates the named folder in the chosen location', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cockpit-new-'))
    expect(createProjectFolder(join(parent, 'Bakery site'))).toEqual({ path: join(parent, 'Bakery site') })
    expect(statSync(join(parent, 'Bakery site')).isDirectory()).toBe(true)
  })
  it('reuses an empty folder of that name', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cockpit-new-'))
    mkdirSync(join(parent, 'empty'))
    expect(createProjectFolder(join(parent, 'empty'))).toEqual({ path: join(parent, 'empty') })
  })
  it('never touches a folder or file that is already there', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cockpit-new-'))
    mkdirSync(join(parent, 'taken'))
    writeFileSync(join(parent, 'taken', 'keep.txt'), 'x')
    writeFileSync(join(parent, 'note.txt'), 'x')
    expect(createProjectFolder(join(parent, 'taken'))).toEqual({ error: expect.stringMatching(/already has files/) })
    expect(existsSync(join(parent, 'taken', 'keep.txt'))).toBe(true)
    expect(createProjectFolder(join(parent, 'note.txt'))).toEqual({ error: expect.stringMatching(/already a file/) })
  })
  it('refuses names that would hide the folder or a missing location', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cockpit-new-'))
    expect(createProjectFolder(join(parent, '.secret'))).toEqual({ error: expect.stringMatching(/can't start with a dot/) })
    expect(createProjectFolder(join(parent, 'gone', 'child'))).toEqual({ error: expect.stringMatching(/location/) })
    expect(createProjectFolder('relative/path')).toEqual({ error: expect.stringMatching(/location/) })
  })
})
