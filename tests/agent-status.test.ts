import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentStatus, latestUsage, probeVersion, type Installation } from '../server/agents/status.ts'
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
  it('reports installation per agent and caches the version check for a minute', async () => {
    let probes = 0
    let clock = 0
    const probe = async (command: string): Promise<Installation> => {
      probes += 1
      return command === 'claude' ? { installed: true, version: '2.1.284 (Claude Code)' } : { installed: false, problem: 'codex is not installed or not on your PATH' }
    }
    const status = createAgentStatus(newStore(), probe, () => clock)
    const first = await status()
    expect(first).toEqual([
      { id: 'claude', installation: { installed: true, version: '2.1.284 (Claude Code)' } },
      { id: 'codex', installation: { installed: false, problem: 'codex is not installed or not on your PATH' } },
    ])
    await status()
    expect(probes).toBe(2)
    clock = 61_000
    await status()
    expect(probes).toBe(4)
  })

  it('says plainly when a CLI is missing', async () => {
    const result = await probeVersion('cockpit-no-such-agent-cli')
    expect(result).toEqual({ installed: false, problem: 'cockpit-no-such-agent-cli is not installed or not on your PATH' })
  })
})
