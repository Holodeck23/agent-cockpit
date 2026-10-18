import { expect, it } from 'vitest'
import { assessNativeMemoryRequest } from '../scripts/lib/w13-memory-request.ts'

const selected = 'selected-memory-' + 'a'.repeat(32), excluded = 'excluded-memory-' + 'b'.repeat(32)
const prompt = 'Reply without tools using the synthetic memory if available.'
it('observes a canary only in actual model context, including native developer instructions', () => {
  expect(assessNativeMemoryRequest({ instructions: selected, input: [{ role: 'user', content: prompt }] }, selected, excluded, prompt)).toMatchObject({ selectedLoaded: true, excludedAbsent: true })
  expect(assessNativeMemoryRequest({ input: [{ role: 'developer', content: selected }, { role: 'user', content: prompt }] }, selected, excluded, prompt)).toMatchObject({ selectedLoaded: true })
})
it('cannot pass by metadata, source filename, prompt echo, or an unselected-memory leak', () => {
  expect(() => assessNativeMemoryRequest({ metadata: { selected }, input: prompt }, selected, excluded, prompt)).toThrow()
  expect(() => assessNativeMemoryRequest({ input: 'memories/memory_summary.md' }, selected, excluded, prompt)).toThrow()
  expect(() => assessNativeMemoryRequest({ input: selected }, selected, excluded, selected)).toThrow()
  expect(() => assessNativeMemoryRequest({ input: [selected, excluded] }, selected, excluded, prompt)).toThrow()
})
it('requires disabled memory to stay absent while retaining an actual native model input', () => {
  expect(assessNativeMemoryRequest({ input: prompt }, selected, excluded, prompt, false)).toMatchObject({ selectedLoaded: false, excludedAbsent: true })
  for (const input of [selected, excluded, [selected, excluded]]) {
    expect(() => assessNativeMemoryRequest({ input }, selected, excluded, prompt, false)).toThrow()
  }
  expect(() => assessNativeMemoryRequest({ metadata: { disabled: true } }, selected, excluded, prompt, false)).toThrow()
})
