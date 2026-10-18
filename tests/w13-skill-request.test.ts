import { expect, it } from 'vitest'
import { assessNativeSkillRequest, assessNativeSkillResource } from '../scripts/lib/w13-skill-request.ts'

const selected = 'selected-skill-' + 'a'.repeat(32), excluded = 'other-skill-' + 'b'.repeat(32)
const args = '  --label "two words"\n--target fixture  ', resource = 'resource-' + 'c'.repeat(32)
const input = (text: string) => [{ role: 'developer', content: [{ type: 'input_text', text: selected }] }, { role: 'user', content: [{ type: 'input_text', text }] }]
it('observes native source selection and exact arguments without inventing a resource read', () => {
  expect(assessNativeSkillRequest({ input: input(args) }, selected, excluded, args, resource))
    .toEqual({ selectedLoaded: true, excludedAbsent: true, argumentsPreserved: true, resourceInContext: false })
})
it('requires a native selected-resource tool result, not assistant text or metadata', () => {
  const result = { type: 'function_call_output', call_id: 'read-resource', output: resource }
  expect(assessNativeSkillResource({ input: [result] }, 'read-resource', resource, excluded)).toMatchObject({ resourceRead: true })
  for (const input of [[{ type: 'message', content: resource }], [{ ...result, call_id: 'other' }], [result, result],
    [{ ...result, output: 'missing' }], [result, { type: 'message', content: excluded }]]) {
    expect(() => assessNativeSkillResource({ input }, 'read-resource', resource, excluded)).toThrow()
  }
})
it('refuses normalized/lost arguments and arguments found only in metadata', () => {
  expect(() => assessNativeSkillRequest({ input: input(args.trim()) }, selected, excluded, args, resource)).toThrow()
  expect(() => assessNativeSkillRequest({ input: input('no arguments'), metadata: { args } }, selected, excluded, args, resource)).toThrow()
})
