import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createHostActions } from '../server/threads/host-actions.ts'

describe('Cockpit host actions', () => {
  const setup = () => {
    const events: NormalizedEvent[] = []
    const actions = createHostActions((_threadId, event) => events.push(event))
    const lastRequest = () => events.findLast((e) => e.kind === 'approval_request') as Extract<NormalizedEvent, { kind: 'approval_request' }>
    return { events, actions, lastRequest }
  }

  it('remembers Allow for this session per conversation and key, until the session ends', async () => {
    const { actions, lastRequest } = setup()
    const first = actions.request('t1', 'mcp__cockpit__start_process', { command: 'npm run dev' }, undefined, { sessionKey: 'processes', label: 'Cockpit action' })
    expect(lastRequest().suggestions).toHaveLength(1)
    actions.approve('t1', lastRequest().requestId, 'allow_session')
    await first
    // The same kind of action in the same session runs without a card.
    await expect(actions.request('t1', 'mcp__cockpit__stop_process', {}, undefined, { sessionKey: 'processes' })).resolves.toBe('allow_session')
    // Another conversation, or another kind of action, still asks.
    void actions.request('t2', 'mcp__cockpit__start_process', {}, undefined, { sessionKey: 'processes' }).catch(() => undefined)
    expect(lastRequest().toolName).toBe('mcp__cockpit__start_process')
    actions.cancel('t2')
    actions.forget('t1')
    const after = actions.request('t1', 'mcp__cockpit__start_process', {}, undefined, { sessionKey: 'processes' })
    actions.approve('t1', lastRequest().requestId, 'deny')
    await expect(after).rejects.toThrow(/denied/)
  })

  it('never offers Allow for this session without a key, and treats it as one approval', async () => {
    const { actions, lastRequest, events } = setup()
    const once = actions.request('t1', 'mcp__cockpit__remember', { text: 'x' }, undefined, { label: 'Cockpit action' })
    expect(lastRequest().suggestions).toEqual([])
    actions.approve('t1', lastRequest().requestId, 'allow_session')
    await once
    expect(events.at(-1)).toMatchObject({ kind: 'approval_resolved', behavior: 'allow' })
    const again = actions.request('t1', 'mcp__cockpit__remember', { text: 'y' }, undefined, { label: 'Cockpit action', timeoutMs: 20 })
    await expect(again).rejects.toThrow(/Cockpit action approval expired/)
  })
})

it('records deadlines, expiry and cancellation separately from a person denying', async () => {
  const events: NormalizedEvent[] = []
  const actions = createHostActions((_id, event) => events.push(event))
  const expires = actions.request('t', 'Read', {}, undefined, { timeoutMs: 10 })
  expect(events[0]).toMatchObject({ kind: 'approval_request', expiresAt: expect.any(String) })
  await expect(expires).rejects.toThrow('expired')
  expect(events.at(-1)).toMatchObject({ behavior: 'deny', outcome: 'expired' })
  const controller = new AbortController()
  const canceled = actions.request('t', 'Read', {}, controller.signal)
  controller.abort()
  await expect(canceled).rejects.toThrow('disconnected')
  expect(events.at(-1)).toMatchObject({ behavior: 'deny', outcome: 'canceled' })
  const denied = actions.request('t', 'Read', {})
  const request = events.at(-1) as Extract<NormalizedEvent, { kind: 'approval_request' }>
  actions.approve('t', request.requestId, 'deny')
  await expect(denied).rejects.toThrow('denied by the user')
  expect(events.at(-1)).toEqual({ kind: 'approval_resolved', requestId: request.requestId, behavior: 'deny' })
})
