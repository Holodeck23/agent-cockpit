import { describe, expect, it } from 'vitest'
import { browserInputs, createBrowserLeases, KEYS, originClass, redactBrowserEvent } from '../server/browser/agent-policy.ts'
import { dragPath, insideViewport, KEY_EVENTS, refParts } from '../electron/browser-policy.ts'

// H3 policy pieces (wave 9 order 11): which addresses count as local, how grants are scoped and
// revoked, what the tool inputs accept, and that typed text never reaches the log.

describe('browser origins for agent policy', () => {
  it('treats the person’s local apps as local and Cockpit itself as refused', () => {
    expect(originClass('http://localhost:5173/', [4000])).toBe('local')
    expect(originClass('http://127.0.0.1:8080/x', [4000])).toBe('local')
    expect(originClass('http://app.localhost:3000/', [4000])).toBe('local')
    expect(originClass('http://127.0.0.1:4000/api/threads', [4000])).toBe('refused')
    expect(originClass('http://[::1]:4000/', [4000])).toBe('refused')
  })

  it('treats any other http(s) site as remote and other schemes as refused', () => {
    expect(originClass('https://example.com/', [])).toBe('remote')
    expect(originClass('http://192.168.1.4:3000/', [])).toBe('remote')
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'devtools://x', 'not a url', 'cockpit-proof-app://run']) {
      expect(originClass(raw, [])).toBe('refused')
    }
  })
})

describe('browser leases', () => {
  const scope = { threadId: 't1', runId: 'r1', pageKey: 'thread:t1', origin: 'https://a.test' }

  it('covers exactly one run, page and origin', () => {
    const leases = createBrowserLeases()
    leases.grant(scope)
    expect(leases.has(scope)).toBe(true)
    expect(leases.has({ ...scope, origin: 'https://b.test' })).toBe(false)
    expect(leases.has({ ...scope, origin: 'http://a.test' })).toBe(false)
    expect(leases.has({ ...scope, runId: 'r2' })).toBe(false)
    expect(leases.has({ ...scope, threadId: 't2', pageKey: 'thread:t2' })).toBe(false)
  })

  it('drops grants of any other run, and on Deny or a destroyed page', () => {
    const leases = createBrowserLeases()
    leases.grant(scope)
    leases.grant({ ...scope, threadId: 't2', pageKey: 'thread:t2' })
    expect(leases.keepRun('t1', 'r1')).toBe(0)
    expect(leases.keepRun('t1', 'r2')).toBe(1)
    expect(leases.has(scope)).toBe(false)
    leases.grant(scope)
    expect(leases.keepRun('t1', undefined)).toBe(1)
    leases.grant(scope)
    expect(leases.revokeThread('t1')).toBe(1)
    expect(leases.revokePage('thread:t2')).toBe(1)
    expect(leases.list()).toEqual([])
  })
})

describe('browser tool inputs', () => {
  it('refuses fields an agent may not set, such as a run', () => {
    expect(browserInputs.click.safeParse({ revision: 1, x: 1, y: 1, runId: 'other' }).success).toBe(false)
    expect(browserInputs.read.safeParse({ workspaceId: 'w' }).success).toBe(false)
    expect(browserInputs.navigate.safeParse({ url: 'https://a.test', threadId: 't2' }).success).toBe(false)
  })

  it('takes a target as a ref or as a full point, never both or half', () => {
    expect(browserInputs.click.safeParse({ revision: 3, ref: 'e3-0' }).success).toBe(true)
    expect(browserInputs.click.safeParse({ revision: 3, x: 10, y: 20 }).success).toBe(true)
    expect(browserInputs.click.safeParse({ revision: 3, x: 10 }).success).toBe(false)
    expect(browserInputs.click.safeParse({ revision: 3, ref: 'e3-0', x: 1, y: 1 }).success).toBe(false)
    expect(browserInputs.click.safeParse({ revision: 3, ref: 'node-17' }).success).toBe(false)
    expect(browserInputs.click.safeParse({ x: 1, y: 1 }).success).toBe(false)
    expect(browserInputs.type.safeParse({ revision: 3, text: 'hi' }).success).toBe(true)
    expect(browserInputs.navigate.safeParse({ url: 'https://a.test', action: 'back' }).success).toBe(false)
  })

  it('bounds typing, scrolling, drags and keys', () => {
    expect(browserInputs.type.safeParse({ revision: 1, text: 'x'.repeat(2001) }).success).toBe(false)
    expect(browserInputs.scroll.safeParse({ revision: 1, dy: 6000 }).success).toBe(false)
    expect(browserInputs.drag.safeParse({ revision: 1, from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, steps: 21 }).success).toBe(false)
    expect(browserInputs.key.safeParse({ revision: 1, key: 'F12' }).success).toBe(false)
    expect(browserInputs.key.safeParse({ revision: 1, key: 'Enter', modifiers: ['hyper'] }).success).toBe(false)
  })

  it('has an Electron key event for every key the tool accepts', () => {
    expect(KEYS.filter((key) => !KEY_EVENTS[key])).toEqual([])
  })
})

describe('typed text never reaches the log', () => {
  const secret = 'hunter2-correct-horse'
  it('keeps only the length of a browser_type call, its approval card and a helper’s use of it', () => {
    const events = [
      redactBrowserEvent({ kind: 'tool_use', id: 'u1', name: 'mcp__cockpit__browser_type', input: { revision: 4, ref: 'e4-1', text: secret } }),
      redactBrowserEvent({ kind: 'approval_request', requestId: 'a1', toolName: 'mcp__cockpit__browser_type', input: { text: secret, revision: 4 }, suggestions: [] }),
      redactBrowserEvent({ kind: 'subagent', id: 's1', phase: 'progress', tool: { name: 'mcp__cockpit__browser_type', input: { text: secret } } }),
    ]
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(events[0]).toMatchObject({ input: { revision: 4, ref: 'e4-1', characters: secret.length } })
    expect(events[1]).toMatchObject({ input: { characters: secret.length } })
  })

  it('leaves other tools alone', () => {
    const event = { kind: 'tool_use' as const, id: 'u2', name: 'Bash', input: { command: 'echo hi', text: 'kept' } }
    expect(redactBrowserEvent(event)).toBe(event)
  })
})

describe('host input geometry', () => {
  it('reads a ref’s revision and refuses anything else', () => {
    expect(refParts('e12-3')).toEqual({ revision: 12, index: 3 })
    expect(refParts('e12')).toBeUndefined()
    expect(refParts('x12-3')).toBeUndefined()
  })

  it('accepts only points inside the viewport', () => {
    const viewport = { width: 390, height: 600 }
    expect(insideViewport(0, 0, viewport)).toBe(true)
    expect(insideViewport(389, 599, viewport)).toBe(true)
    expect(insideViewport(390, 10, viewport)).toBe(false)
    expect(insideViewport(-1, 10, viewport)).toBe(false)
    expect(insideViewport(Number.NaN, 10, viewport)).toBe(false)
  })

  it('moves a drag in even steps that end exactly at the target, at most 20', () => {
    expect(dragPath({ x: 0, y: 0 }, { x: 100, y: 50 }, 4)).toEqual([{ x: 25, y: 13 }, { x: 50, y: 25 }, { x: 75, y: 38 }, { x: 100, y: 50 }])
    expect(dragPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 99)).toHaveLength(20)
  })
})
