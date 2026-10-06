import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isRemoteRoute } from '../server/remote/guard.ts'
import { startServer, type RunningServer } from '../server/start.ts'

// The lifecycle routes (W10.2/W10.3): desktop only, explicit, and refusals carry the manual route.
// Nothing here runs a real installer: OpenCode has no guided install, and Claude is only planned.
describe('agent lifecycle routes', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  const start = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-lifecycle-routes-'))
    running = await startServer({ port: 0, webDist: dir, stateRoot: dir, capabilities: { get: async (agent) => ({
      agent, context: 'default', executable: { state: 'missing', reason: `${agent} absent` }, models: { state: 'not_checked' }, settings: {}, auth: { state: 'not_checked' },
    }) } })
    return (path: string, body?: unknown) => fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  it('shows the install plan before anything runs, with destination and what to expect', async () => {
    const call = await start()
    const res = await call('/api/agents/claude/lifecycle')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.install).toMatchObject({ available: true, destination: expect.stringMatching(/\.local\/bin\/claude$/), interaction: expect.stringMatching(/prints nothing/) })
    expect(data.update).toMatchObject({ available: false })
    expect(data.operations).toEqual([])
  })

  it('refuses what Cockpit does not run, with the manual command, and unknown operations', async () => {
    const call = await start()
    const res = await call('/api/agents/opencode/install', {})
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/opencode/)
    expect((await call('/api/agent-operations/nope')).status).toBe(404)
    expect((await call('/api/agents/claude/updates/skip', { version: 'latest; rm -rf /' })).status).toBe(400)
  })

  it('keeps every lifecycle route off the phone', () => {
    for (const [method, path] of [['GET', '/api/agents/claude/lifecycle'], ['POST', '/api/agents/claude/install'], ['POST', '/api/agents/codex/update'], ['POST', '/api/agents/codex/signin'],
      ['POST', '/api/agents/claude/updates/check'], ['POST', '/api/agent-operations/x/cancel'], ['POST', '/api/agent-operations/x/input'], ['GET', '/api/agent-operations/x']] as const) {
      expect(isRemoteRoute(method, path)).toBe(false)
    }
  })
})
