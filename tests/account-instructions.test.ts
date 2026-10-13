import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureSharedInstructions } from '../server/agents/accounts/instructions.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-account-instructions-'))
  const home = join(root, 'home')
  const profile = join(root, 'profile')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(profile)
  return { root, home, profile }
}

describe('managed profile instruction continuity', () => {
  it.each([
    ['claude', '.claude', 'CLAUDE.md'],
    ['codex', '.codex', 'AGENTS.md'],
  ] as const)('links only the %s global instruction entry file', (agent, sourceDir, name) => {
    const { home, profile } = fixture()
    const source = join(home, sourceDir, name)
    writeFileSync(source, 'first rules\n')
    writeFileSync(join(home, sourceDir, 'credentials.json'), 'never share me\n')
    mkdirSync(join(home, sourceDir, 'skills'))

    expect(ensureSharedInstructions(agent, profile, home)).toBe('linked')
    const target = join(profile, name)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(readlinkSync(target)).toBe(source)
    expect(readFileSync(target, 'utf8')).toBe('first rules\n')
    expect(existsSync(join(profile, 'credentials.json'))).toBe(false)
    expect(existsSync(join(profile, 'skills'))).toBe(false)

    writeFileSync(source, 'updated rules\n')
    expect(readFileSync(target, 'utf8')).toBe('updated rules\n')
  })

  it('keeps a profile-owned entry and does not replace it', () => {
    const { home, profile } = fixture()
    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'global\n')
    writeFileSync(join(profile, 'AGENTS.md'), 'profile owned\n')
    expect(ensureSharedInstructions('codex', profile, home)).toBe('existing')
    expect(lstatSync(join(profile, 'AGENTS.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(profile, 'AGENTS.md'), 'utf8')).toBe('profile owned\n')
  })

  it('does nothing when no standard entry exists and deleting the profile never deletes the source', () => {
    const { home, profile } = fixture()
    expect(ensureSharedInstructions('claude', profile, home)).toBe('missing')
    expect(existsSync(join(profile, 'CLAUDE.md'))).toBe(false)

    const source = join(home, '.claude', 'CLAUDE.md')
    writeFileSync(source, 'keep me\n')
    expect(ensureSharedInstructions('claude', profile, home)).toBe('linked')
    rmSync(profile, { recursive: true })
    expect(readFileSync(source, 'utf8')).toBe('keep me\n')
  })
})
