import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { snapshotMcpSources } from '../server/agents/claude/mcp-sources.ts'

it('binds approved MCP source, executable and script revisions without exposing environment values', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-mcp-sources-'))
  const home = join(root, 'home'), cwd = join(root, 'project')
  mkdirSync(home); mkdirSync(cwd)
  const executable = join(root, 'runner')
  const script = join(root, 'server.js')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o755)
  writeFileSync(script, 'process.stdout.write("ready")')
  const file = join(cwd, '.mcp.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { external: { type: 'stdio', command: executable, args: [script], env: { KEY: 'synthetic-secret' } } } }))
  const input = { home, cwd, pathEnv: '/usr/bin:/bin' }
  const first = snapshotMcpSources(input)
  expect(first.review).toMatchObject([{ name: 'external', source: file, executable: realpathSync(executable) }])
  expect(first.servers.external?.command).toBe(realpathSync(executable))
  expect(JSON.stringify(first.review)).not.toContain('synthetic-secret')
  expect(snapshotMcpSources({ ...input, accountId: 'other-account' }).revision).not.toBe(first.revision)
  expect(snapshotMcpSources({ ...input, accountGeneration: 2 }).revision).not.toBe(first.revision)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 1 }))
  expect(snapshotMcpSources(input).revision).toBe(first.revision)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 2 }))
  expect(snapshotMcpSources(input).revision).toBe(first.revision)
  writeFileSync(script, 'process.stdout.write("changed")')
  expect(snapshotMcpSources(input).revision).not.toBe(first.revision)
  writeFileSync(file, JSON.stringify({ mcpServers: { cockpit: { type: 'stdio', command: executable, args: [] } } }))
  expect(() => snapshotMcpSources(input)).toThrow(/Reserved/)
})
