import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('synthetic Claude proof providers read the scoped grant from the config path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-fixture-env-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { cockpit: { env: {
    COCKPIT_MCP_TOKEN: 'synthetic-token', COCKPIT_MCP_URL: 'http://127.0.0.1:1',
  } } } }))
  const output = execFileSync('sh', ['-c', '. ./scripts/fixtures/claude-mcp-env.sh "$@"; printf "%s|%s" "$COCKPIT_MCP_TOKEN" "$COCKPIT_MCP_URL"', 'fixture', '--mcp-config', file], {
    cwd: process.cwd(), env: { ...process.env, COCKPIT_MCP_TOKEN: '', COCKPIT_MCP_URL: '' }, encoding: 'utf8',
  })
  expect(output).toBe('synthetic-token|http://127.0.0.1:1')
})
