import { expect, it } from 'vitest'
import { assessNativeSkillRequest } from '../scripts/lib/w13-skill-request.ts'

const selected = 'selected-skill-' + 'a'.repeat(32), excluded = 'other-skill-' + 'b'.repeat(32)
const args = '  --label "two words"\n--target fixture  ', resource = 'resource-' + 'c'.repeat(32)
const input = (text: string) => [{ role: 'developer', content: [{ type: 'input_text', text: selected }] }, { role: 'user', content: [{ type: 'input_text', text }] }]
it('observes native source selection and exact arguments without inventing a resource read', () => {
  expect(assessNativeSkillRequest({ input: input(args) }, selected, excluded, args, resource))
    .toEqual({ selectedLoaded: true, excludedAbsent: true, argumentsPreserved: true, resourceInContext: false })
})
it('refuses normalized/lost arguments and arguments found only in metadata', () => {
  expect(() => assessNativeSkillRequest({ input: input(args.trim()) }, selected, excluded, args, resource)).toThrow()
  expect(() => assessNativeSkillRequest({ input: input('no arguments'), metadata: { args } }, selected, excluded, args, resource)).toThrow()
})
