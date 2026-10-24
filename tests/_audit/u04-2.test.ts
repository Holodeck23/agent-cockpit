import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCodexModels } from '../../server/agents/capabilities/probes.ts'
import { codexLaunchSchema, launchCodex } from '../../server/agents/codex/launch.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'

// u04-2: parseCodexModels (probes.ts:143) lists ids matching [A-Za-z0-9._\-[\]/:]{1,100}, and
// threadSettingsSchema (types.ts:11) saves them, but codexLaunchSchema.model (launch.ts:18) omits
// "/" and ":", so launchCodex throws a ZodError for a model Cockpit itself offered and saved.
// CORRECT behaviour: an id the picker lists and the settings accept launches (it reaches thread/start).
const IDS = ['gpt-oss:20b', 'openai/gpt-oss-120b']

describe('u04-2: Codex model ids the picker lists must be launchable', () => {
  it('every id parseCodexModels lists passes the launch schema', () => {
    const listed = parseCodexModels({ data: IDS.map((id) => ({ id })) }).map((m) => m.id)
    expect(listed).toEqual(IDS)
    for (const id of listed) {
      expect(threadSettingsSchema.safeParse({ agent: 'codex', model: id }).success).toBe(true)
      expect(codexLaunchSchema.safeParse({ cwd: '/tmp', model: id }).success, `launch schema rejects listed id ${id}`).toBe(true)
    }
  })

  it('launchCodex starts the app-server and passes a listed id on thread/start instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-audit-u04-2-'))
    const log = join(dir, 'requests.jsonl')
    const executable = join(dir, 'codex')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method) fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
    if (m.method === 'initialize') send({ id: m.id, result: {} })
    if (m.method === 'config/read') send({ id: m.id, result: {"config":{"features":{"hooks":false,"plugins":false,"apps":false,"enable_mcp_apps":false,"skill_mcp_dependency_install":false},"notify":[],"mcp_servers":{}},"layers":[{"name":{"type":"sessionFlags"},"config":{}}]} })
    if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th1' } } })
  }
})
`)
    chmodSync(executable, 0o755)
    for (const model of IDS) {
      const events: NormalizedEvent[] = []
      let session: ReturnType<typeof launchCodex> | undefined
      expect(() => { session = launchCodex({ cwd: dir, model }, (e) => events.push(e), { executable }) }, `launchCodex threw for ${model}`).not.toThrow()
      try {
        await expect.poll(() => events.some((e) => e.kind === 'session'), { timeout: 8000 }).toBe(true)
        const start = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method: string; params?: { model?: string } }).filter((m) => m.method === 'thread/start').pop()
        expect(start?.params?.model).toBe(model)
      } finally {
        await session?.close()
      }
    }
  }, 30_000)
})
