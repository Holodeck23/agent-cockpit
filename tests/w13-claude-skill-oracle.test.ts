import { expect, it } from 'vitest'
import { ClaudeSkillResourceOracle } from '../scripts/lib/w13-claude-skill-oracle.ts'
const marker = 'selected-' + 'a'.repeat(32), resource = 'reference-' + 'b'.repeat(32), excluded = 'excluded-' + 'c'.repeat(32)
const args = '--label "two words"  --target fixture'
const path = '/owned/skill/reference.txt'
const fresh = () => new ClaudeSkillResourceOracle('session', path, marker, resource, excluded, args)
const tool = (file = path, name = 'Read') => ({ type: 'assistant', session_id: 'session', message: { content: [{ type: 'tool_use', id: 'read', name, input: { file_path: file } }] } })
const result = (id = 'read', content = resource) => ({ type: 'user', session_id: 'session', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const done = { session_id: 'session', subtype: 'success', is_error: false, result: `${marker}\n${resource}\n${args}` }
it('requires a permitted native Read result and exact source/arguments before success', () => {
  const oracle = fresh(); oracle.policyAdmissions = 1; oracle.record(tool()); oracle.record(result())
  expect(oracle.complete(done, resource)).toMatchObject({ resourceRead: true, argumentsPreserved: true })
})
it.each([['Read', '/other/reference.txt'], ['Read', 'reference.txt'], ['Bash', path], ['Read', '/owned/skill/reference.txt/other']])('refuses non-selected resource/tool %s %s', (name, file) => {
  expect(fresh().permits(name, { file_path: file })).toBe(false)
  expect(() => fresh().record(tool(file, name))).toThrow()
})
it('cannot pass from final model text alone or a native result from a different call/session', () => {
  const oracle = fresh(); oracle.policyAdmissions = 1
  expect(() => oracle.complete(done, '')).toThrow()
  expect(() => oracle.record(result())).toThrow()
  oracle.record(tool())
  expect(() => oracle.record(result('other'))).toThrow()
  expect(() => oracle.record({ ...result(), session_id: 'other' })).toThrow()
  expect(() => oracle.record(result('read', 'absent'))).toThrow()
})
it('refuses changed arguments, excluded content and missing native pre-tool guard', () => {
  const oracle = fresh(); oracle.record(tool()); oracle.record(result())
  expect(() => oracle.complete(done, '')).toThrow()
  oracle.policyAdmissions = 1
  expect(() => oracle.complete({ ...done, result: done.result.replace('  --target', ' --target') }, '')).toThrow()
  expect(() => oracle.complete(done, excluded)).toThrow()
})
