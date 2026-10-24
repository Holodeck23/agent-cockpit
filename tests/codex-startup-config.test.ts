import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-codex-startup-config-'))
  const executable = join(root, 'codex'), context = join(root, 'context.json')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(context)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }))
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line)
  if (r.method === 'config/read') { process.stdout.write(JSON.stringify({ id: r.id, result: {"config":{"features":{"hooks":false,"plugins":false,"apps":false,"enable_mcp_apps":false,"skill_mcp_dependency_install":false},"notify":[],"mcp_servers":{}},"layers":[{"name":{"type":"sessionFlags"},"version":"sha256:0000000000000000000000000000000000000000000000000000000000000000","config":{}}]} }) + '\\n'); return }
  if (r.id !== undefined) process.stdout.write(JSON.stringify({ id: r.id, result:
    r.method === 'thread/start' || r.method === 'thread/resume' ? { thread: { id: 'fixture-thread' } } : { ok: true } }) + '\\n')
})
`)
  chmodSync(executable, 0o755)
  return { root, executable, read: () => JSON.parse(readFileSync(context, 'utf8')) as { args: string[]; home: string } }
}

// Evaluate duplicates in CLI order: the last launch override must win.
function effective(args: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
    const pair = args[++i]!, equals = pair.indexOf('=')
    values.set(pair.slice(0, equals), pair.slice(equals + 1))
  }
  return values
}

function expectSuppressed(args: string[]) {
  const values = effective(args)
  for (const key of ['hooks', 'plugins', 'apps', 'enable_mcp_apps', 'skill_mcp_dependency_install']) {
    expect(values.get(`features.${key}`)).toBe('false')
  }
  expect(values.get('notify')).toBe('[]')
  // Do not mistake an empty table for disabling inherited MCP servers.
  expect(values.has('mcp_servers')).toBe(false)
}

it.each([false, true])('suppresses executable features on new/resumed conversations without changing account or bridge (%s)', async (resume) => {
  const f = fixture(), events: NormalizedEvent[] = []
  const profile = join(f.root, 'selected-account')
  const session = launchCodex({ cwd: f.root, ...(resume ? { resume: 'saved-thread' } : {}) }, event => events.push(event), {
    executable: f.executable, env: { CODEX_HOME: profile }, configArgs: [
      '-c', 'features.hooks=true', '-c', 'features.plugins=true', '-c', 'notify=["unreviewed"]',
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'mcp_servers.cockpit.command="reviewed-bridge"',
    ],
  })
  try {
    await expect.poll(() => events.some(event => event.kind === 'session')).toBe(true)
    const context = f.read(), values = effective(context.args)
    expectSuppressed(context.args)
    expect(context.home).toBe(profile)
    expect(values.get('sandbox_workspace_write.network_access')).toBe('false')
    expect(values.get('mcp_servers.cockpit.command')).toBe('"reviewed-bridge"')
  } finally { await session.close() }
})

it.each(['account/read', 'model/list'])('applies the same controls before a non-generating helper initializes: %s', async (method) => {
  const f = fixture(), profile = join(f.root, 'selected-account')
  const answer = await queryAppServer(f.executable, method, {}, {
    env: { ...process.env, CODEX_HOME: profile }, timeoutMs: 5000,
  })
  expect(answer).toEqual({ result: { ok: true } })
  expectSuppressed(f.read().args)
  expect(f.read().home).toBe(profile)
})
