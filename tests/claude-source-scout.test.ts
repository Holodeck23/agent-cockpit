import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scoutClaudeSources } from '../server/agents/setup/claude-source-scout.ts'

it('keeps profile, root and nested source candidates separate without reading their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-claude-scout-'))
  const home = join(root, 'home'), profileDir = join(home, '.claude'), workspaceRoot = join(root, 'project')
  const cwd = join(workspaceRoot, 'nested')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(cwd, { recursive: true })
  mkdirSync(join(profileDir, 'projects'))
  mkdirSync(join(workspaceRoot, '.claude'))
  writeFileSync(join(profileDir, 'settings.json'), '{syntactically invalid, but scouting does not parse it')
  writeFileSync(join(workspaceRoot, '.claude', 'settings.json'), 'private root settings')
  writeFileSync(join(cwd, '.mcp.json'), 'private nested MCP')
  symlinkSync(join(profileDir, 'projects'), join(cwd, '.claude'))
  const first = scoutClaudeSources({ home, profileDir, workspaceRoot, cwd })
  expect(first.find((row) => row.path === join(profileDir, 'settings.json'))?.state).toBe('file')
  expect(first.find((row) => row.path === join(profileDir, 'projects'))?.state).toBe('directory')
  expect(first.find((row) => row.path === join(cwd, '.mcp.json'))).toMatchObject({ scope: 'project', depth: 1, state: 'file' })
  expect(first.find((row) => row.path === join(cwd, '.claude'))?.state).toBe('link')
  expect(first.find((row) => row.path === join(cwd, '.claude', 'settings.json'))?.state).toBe('missing')
  expect(first.filter((row) => row.kind === 'instruction' && row.scope === 'project')).toHaveLength(6)
  expect(scoutClaudeSources({ home, profileDir, workspaceRoot, cwd })).toEqual(first)
})

it('rejects a cwd outside the selected workspace', () => {
  expect(() => scoutClaudeSources({ home: '/tmp/home', profileDir: '/tmp/home/.claude',
    workspaceRoot: '/tmp/project', cwd: '/tmp/other' })).toThrow(/leaves the selected workspace/)
})
