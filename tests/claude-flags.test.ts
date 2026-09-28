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
})
