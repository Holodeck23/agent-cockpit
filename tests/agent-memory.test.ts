import { describe, expect, it } from 'vitest'
import { defaultPermission, parseMemory, permissionModesFor, recall, remember } from '../web/src/agent-memory.ts'

describe('per-agent settings memory', () => {
  it('switching back to an agent restores its model, effort and permissions', () => {
    let memory = remember({}, { agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' })
    memory = remember(memory, { agent: 'codex', model: 'gpt-x', effort: 'low', permissionMode: 'plan' })
    expect(recall(memory, 'claude')).toEqual({ agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' })
    expect(recall(memory, 'codex')).toEqual({ agent: 'codex', model: 'gpt-x', effort: 'low', permissionMode: 'plan' })
  })

  it('an agent never chosen starts from its defaults: Antigravity bypasses, the rest ask', () => {
    expect(recall({}, 'opencode')).toEqual({ agent: 'opencode', model: '', effort: '', permissionMode: 'manual' })
    expect(recall({}, 'antigravity').permissionMode).toBe('bypassPermissions')
    expect(defaultPermission('claude')).toBe('manual')
  })

  it('keeps an explicit Antigravity permission choice instead of the Bypass default (W10-03)', () => {
    expect(recall({ antigravity: { model: 'gemini-3.1-pro-high', effort: '', permissionMode: 'manual' } }, 'antigravity')).toMatchObject({ model: 'gemini-3.1-pro-high', permissionMode: 'manual' })
    expect(recall({ antigravity: { model: '', effort: '', permissionMode: 'plan' } }, 'antigravity').permissionMode).toBe('plan')
  })

  it('a remembered mode the agent no longer offers falls back to its default', () => {
    expect(recall({ antigravity: { model: '', effort: '', permissionMode: 'acceptEdits' } }, 'antigravity').permissionMode).toBe('bypassPermissions')
  })

  it('survives bad storage', () => {
    expect(parseMemory('nonsense')).toEqual({})
    expect(parseMemory('{"claude":{"model":7}}')).toEqual({})
    expect(parseMemory('{"claude":{"model":"opus","effort":"high","permissionMode":"plan"},"evil":{}}')).toEqual({ claude: { model: 'opus', effort: 'high', permissionMode: 'plan' } })
  })
})

describe('permission modes per agent', () => {
  it('Antigravity offers only what its CLI can do: bypass, its own configured policy, plan', () => {
    expect(permissionModesFor('antigravity')).toEqual(['bypassPermissions', 'manual', 'plan'])
    expect(permissionModesFor('claude')).toContain('acceptEdits')
  })
})
