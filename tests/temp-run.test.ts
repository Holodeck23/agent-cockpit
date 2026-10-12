import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRunFolder, isProcessAlive, isRunFolder, RUN_FOLDER_NAME, RUN_MARKER, removeRunFolder, runFolderOwner } from '../scripts/lib/temp-run.ts'

describe('the vitest run folder', () => {
  // vitest.config.ts globalSetup (tests/setup/global-temp.ts) points TMPDIR at one short folder
  // before the workers start. If this fails, temp dirs of the whole suite are leaking again.
  it('is where this worker\'s temp dir is', () => {
    const dir = tmpdir()
    expect(basename(dir)).toMatch(RUN_FOLDER_NAME)
    expect(isRunFolder(dir)).toBe(true)
    expect(runFolderOwner(dir)).toBeGreaterThan(0)
    expect(process.env.TMPDIR).toBe(dir)
  })

  it('catches what a test makes with mkdtemp', () => {
    const made = mkdtempSync(join(tmpdir(), 'cockpit-redirect-check-'))
    try {
      expect(dirname(made)).toBe(tmpdir())
      expect(lstatSync(made).isDirectory()).toBe(true)
    } finally {
      rmSync(made, { recursive: true, force: true })
    }
  })
})

describe('run folders', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cockpit-run-test-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('have a 7-byte name, so a unix socket under TMPDIR still fits the 104-byte limit', () => {
    const dir = createRunFolder(base)
    expect(basename(dir)).toMatch(RUN_FOLDER_NAME)
    expect(Buffer.byteLength(basename(dir))).toBe(7)
    // The usual per-user temp dir is 48 bytes; Chromium's single-instance socket sits 46 bytes below TMPDIR.
    const usual = '/var/folders/kq/08d3yrk57_xby50ryylf0j9h0000gn/T'
    expect(Buffer.byteLength(usual)).toBe(48)
    const socket = join(usual, basename(dir), '.org.chromium.Chromium.AbCdEf', 'SingletonSocket')
    expect(Buffer.byteLength(socket)).toBeLessThan(104)
  })

  it('record their owner', () => {
    expect(runFolderOwner(createRunFolder(base, 4242))).toBe(4242)
    expect(runFolderOwner(createRunFolder(base))).toBe(process.pid)
  })

  it('are removed whole, with whatever was made inside', () => {
    const dir = createRunFolder(base)
    mkdirSync(join(dir, 'cockpit-deep', 'er'), { recursive: true })
    writeFileSync(join(dir, 'cockpit-deep', 'er', 'file'), 'x')
    expect(removeRunFolder(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('are the only thing removeRunFolder removes', () => {
    const plain = join(base, 'kAbC123')
    mkdirSync(plain)
    writeFileSync(join(plain, 'keep'), 'x')
    expect(removeRunFolder(plain)).toBe(false) // right name, no marker
    const marked = join(base, 'not-a-run-folder')
    mkdirSync(marked)
    writeFileSync(join(marked, RUN_MARKER), '1\n')
    expect(removeRunFolder(marked)).toBe(false) // marker, wrong name
    expect(removeRunFolder(base)).toBe(false)
    expect(removeRunFolder(join(base, 'missing'))).toBe(false)
    const target = createRunFolder(base)
    const link = join(base, 'kLink12')
    symlinkSync(target, link)
    expect(removeRunFolder(link)).toBe(false) // a link to a run folder is not one
    expect(existsSync(join(plain, 'keep'))).toBe(true)
    expect(readFileSync(join(target, RUN_MARKER), 'utf8')).toBe(`${process.pid}\n`)
  })

  it('are told apart from unrelated folders by marker and name together', () => {
    const dir = createRunFolder(base)
    expect(isRunFolder(dir)).toBe(true)
    expect(isRunFolder(base)).toBe(false)
  })

  it('knows a live process from a gone one', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false)
  })
})
