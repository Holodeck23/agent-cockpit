import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../server/agents/claude/flags.ts'

const base = { cwd: '/tmp/project' }

describe('buildClaudeArgs', () => {
  it('always runs headless stream-json with host-answered permissions', () => {
    const args = buildClaudeArgs(base)
    expect(args).toEqual(expect.arrayContaining(['--print', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']))
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual')
  })

  it('disables hooks unless the thread opts in', () => {
    const off = buildClaudeArgs(base)
    expect(off[off.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}')
    const on = buildClaudeArgs({ ...base, useHooks: true })
    expect(on[on.indexOf('--settings') + 1]).toBe('{}')
  })

  it('passes resume and model through', () => {
    const id = '3e6a366b-3f63-435a-a822-c515bd808f9c'
    const args = buildClaudeArgs({ ...base, resume: id, model: 'haiku', effort: 'high' })
    expect(args).toEqual(expect.arrayContaining(['--resume', id, '--model', 'haiku', '--effort', 'high']))
  })

  it('rejects values outside the allowlist', () => {
    expect(() => buildClaudeArgs({ ...base, model: 'haiku; rm -rf /' })).toThrow()
    expect(() => buildClaudeArgs({ ...base, resume: 'not-a-uuid' })).toThrow()
    expect(() =>
      buildClaudeArgs({ ...base, sessionId: '3e6a366b-3f63-435a-a822-c515bd808f9c', resume: '3e6a366b-3f63-435a-a822-c515bd808f9c' }),
    ).toThrow()
  })

  it('passes pre-allowed tools and rejects anything that is not a tool name', () => {
    const args = buildClaudeArgs({ ...base, allowedTools: ['mcp__cockpit__list_processes', 'mcp__cockpit__open_preview'] })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__cockpit__list_processes,mcp__cockpit__open_preview')
    expect(buildClaudeArgs(base)).not.toContain('--allowedTools')
    expect(() => buildClaudeArgs({ ...base, allowedTools: ['Bash(rm -rf /)'] })).toThrow()
  })
})

describe('the appended system prompt (J5)', () => {
  it('passes a prompt file instead of the text, never both', () => {
    const args = buildClaudeArgs({ ...base, appendSystemPromptFile: '/tmp/cockpit-prompt-x/prompt.md' })
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/tmp/cockpit-prompt-x/prompt.md')
    expect(args).not.toContain('--append-system-prompt')
    expect(() => buildClaudeArgs({ ...base, appendSystemPrompt: 'a', appendSystemPromptFile: '/tmp/p.md' })).toThrow()
  })
  it('takes a whole switch handoff', () => {
    expect(() => buildClaudeArgs({ ...base, appendSystemPrompt: 'x'.repeat(450_000) })).not.toThrow()
  })
})

describe('effort levels per agent (C9)', async () => {
  const { effortsFor, effortForClaude } = await import('../server/agents/claude/flags.ts')
  it('offers Ultra for Codex only, and gives agents without it their highest level', () => {
    expect(effortsFor('codex').at(-1)).toBe('ultra')
    expect(effortsFor('claude')).not.toContain('ultra')
    expect(effortForClaude('ultra')).toBe('max')
    expect(effortForClaude('high')).toBe('high')
    expect(() => buildClaudeArgs({ ...base, effort: 'ultra' as never })).toThrow()
  })
})
