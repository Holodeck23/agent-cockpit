// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentId } from '../../server/agents/types.ts'
import type { AgentCapabilities, AgentLifecycleView, OperationView } from '../../web/src/api.ts'
import { AgentLifecycle } from '../../web/src/components/AgentLifecycle.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// u23-4: load() and the operation poll applied their responses whatever agent was showing by then.
// The lifecycle request can be slow (a cold CLI probe), so the answer for the agent the user had
// just left could land after the new one's and replace its install plan and running operation.

interface Pending<T> { agent?: AgentId; id?: string; resolve: (value: T) => void }
const lifecycleCalls: Array<Pending<AgentLifecycleView>> = []
const operationCalls: Array<Pending<OperationView>> = []

vi.mock('../../web/src/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/api.ts')>()
  return { ...actual, api: { ...actual.api,
    agentLifecycle: (agent: AgentId) => new Promise<AgentLifecycleView>((resolve) => { lifecycleCalls.push({ agent, resolve }) }),
    agentOperation: (id: string) => new Promise<OperationView>((resolve) => { operationCalls.push({ id, resolve }) }),
  } }
})

const caps = (agent: AgentId): AgentCapabilities => ({
  agent, context: 'default', executable: { state: 'missing', reason: 'not found' }, models: { state: 'unknown' }, settings: {}, auth: { state: 'unknown' },
} as unknown as AgentCapabilities)
const no = { available: false, reason: 'Not here.' } as const
const view = (destination: string, operations: OperationView[] = []): AgentLifecycleView => ({
  install: { available: true, executable: '/bin/true', args: [], destination, interaction: 'A browser opens.' }, update: no, signin: no, operations,
})
const running = (agent: AgentId, id: string): OperationView => ({ id, agent, kind: 'install', state: 'installing', startedAt: new Date().toISOString(), lines: [], logFile: '/dev/null' })

describe('agent lifecycle panel across a change of agent', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    lifecycleCalls.length = 0
    operationCalls.length = 0
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const show = (agent: AgentId) => act(async () => root.render(createElement(AgentLifecycle, { agent, caps: caps(agent), onChanged: () => undefined })))
  const settle = async <T,>(call: Pending<T> | undefined, value: T): Promise<void> => { await act(async () => { call!.resolve(value) }) }
  const callFor = (agent: AgentId) => lifecycleCalls.find((c) => c.agent === agent)

  it('keeps the new agent\'s plan when the previous agent\'s answer arrives last', async () => {
    await show('claude')
    await show('codex')
    await settle(callFor('codex'), view('/codex/destination'))
    await settle(callFor('claude'), view('/claude/destination'))
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Install…')!.click() })
    expect(host.textContent).toContain('/codex/destination')
    expect(host.textContent).not.toContain('/claude/destination')
  })

  it('does not show the previous agent\'s plan while the new one is loading', async () => {
    await show('claude')
    await settle(callFor('claude'), view('/claude/destination'))
    expect(host.querySelector('.agent-lifecycle')).not.toBeNull()
    await show('codex')
    expect(host.querySelector('.agent-lifecycle')).toBeNull()
  })

  it('ignores a late operation poll from the agent that was left', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await show('claude')
    await settle(callFor('claude'), view('/claude/destination', [running('claude', 'op-claude')]))
    expect(host.querySelector('.lifecycle-op')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(operationCalls.map((c) => c.id)).toEqual(['op-claude'])

    await show('codex')
    await settle(callFor('codex'), view('/codex/destination'))
    expect(host.querySelector('.lifecycle-op')).toBeNull()
    await settle(operationCalls[0], running('claude', 'op-claude'))
    expect(host.querySelector('.lifecycle-op')).toBeNull()
  })
})
