import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentStatus, fixedCapabilities, installationOf, latestUsage } from '../server/agents/status.ts'
import type { AgentCapabilities } from '../server/agents/capabilities/types.ts'
import type { AgentId, NormalizedEvent } from '../server/agents/types.ts'
import { createThreadStore, type ThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

function thread(store: ThreadStore, agent: AgentId, updatedAt: string, events: NormalizedEvent[]): void {
  const id = randomUUID()
  store.create({ id, title: 't', projectPath: '/p', settings: threadSettingsSchema.parse({ agent }), sessionId: randomUUID(),
    sessionStarted: true, completed: false, createdAt: updatedAt, updatedAt })
  for (const event of events) store.append(id, event)
}

const newStore = (): ThreadStore => createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-agents-')))

describe('latestUsage', () => {
  it('keeps the newest report per agent and records when it was observed', async () => {
    const store = newStore()
    thread(store, 'claude', '2026-09-30T08:00:00.000Z', [{ kind: 'usage', limitType: 'five_hour', status: 'allowed', resetsAt: 100 }])
    await new Promise((r) => setTimeout(r, 5))
    thread(store, 'claude', '2026-09-30T09:00:00.000Z', [{ kind: 'usage', limitType: 'five_hour', status: 'rejected', resetsAt: 200, usedPercent: 100 }])
    const usage = latestUsage(store)
    expect(usage.claude).toMatchObject({ status: 'rejected', resetsAt: 200, usedPercent: 100 })
    expect(usage.claude?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(usage.codex).toBeUndefined()
  })

  it('attributes usage to whichever agent was running when it was reported', () => {
    const store = newStore()
    // Settings say codex now, but the first report came from Claude before the switch.
    thread(store, 'codex', '2026-09-30T09:00:00.000Z', [
      { kind: 'usage', limitType: 'five_hour', status: 'rejected' },
      { kind: 'agent_switch', from: 'claude', to: 'codex' },
      { kind: 'usage', limitType: 'five_hour', status: '23% used', usedPercent: 23 },
    ])
    const usage = latestUsage(store)
    expect(usage.claude?.status).toBe('rejected')
    expect(usage.codex).toMatchObject({ status: '23% used', usedPercent: 23 })
  })
})

describe('createAgentStatus', () => {
  const record = (agent: AgentId, executable: AgentCapabilities['executable'], settings: AgentCapabilities['settings'] = {}): AgentCapabilities =>
    ({ agent, context: 'default', executable, settings, models: { state: 'not_checked' }, auth: { state: 'not_checked' } })
  const identity = (command: string, version?: string) => ({ command, path: `/bin/${command}`, realpath: `/bin/${command}`, fingerprint: command, ...(version ? { version } : {}) })

  it('summarizes each capability record: found, not checked, missing, and found but not answering', async () => {
    const records: Record<AgentId, AgentCapabilities> = {
      claude: record('claude', { state: 'found', identity: identity('claude', '2.1.291 (Claude Code)') }, { chrome: { state: 'supported' } }),
      codex: record('codex', { state: 'unavailable', reason: 'codex --version timed out after 10 s', identity: identity('codex') }),
      antigravity: record('antigravity', { state: 'found', identity: identity('agy') }),
      opencode: record('opencode', { state: 'missing', reason: 'opencode is not installed or not on the PATH Cockpit uses' }),
    }
    const asked: string[] = []
    const status = createAgentStatus(newStore(), { get: async (agent, request) => { asked.push(`${agent}:${request?.refresh === true}`); return records[agent] } }, () => '/nowhere/manifest.json')
    expect(await status()).toEqual([
      { id: 'claude', installation: { installed: true, version: '2.1.291 (Claude Code)' }, chrome: { supported: true, extension: false } },
      { id: 'codex', installation: { installed: false, problem: '/bin/codex was found but did not answer: codex --version timed out after 10 s' } },
      // Found, version not checked: Antigravity is not run just to draw the picker.
      { id: 'antigravity', installation: { installed: true } },
      { id: 'opencode', installation: { installed: false, problem: 'opencode is not installed or not on the PATH Cockpit uses' } },
    ])
    // The picker never forces a probe; only Refresh does.
    expect(asked).toEqual(['claude:false', 'codex:false', 'antigravity:false', 'opencode:false'])
  })

  it('serves a fixed answer for tests without running a CLI', async () => {
    const service = fixedCapabilities(async (command) => command === 'claude' ? { installed: true, version: '1' } : { installed: false, problem: `${command} absent` })
    expect(installationOf(await service.get('claude'))).toEqual({ installed: true, version: '1' })
    expect(installationOf(await service.get('codex'))).toEqual({ installed: false, problem: 'codex absent' })
  })
})
