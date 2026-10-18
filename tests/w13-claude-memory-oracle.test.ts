import { expect, it } from 'vitest'
import { assessClaudeMemoryRecall } from '../scripts/lib/w13-claude-memory-oracle.ts'
const selected = 'W13_SELECTED_' + 'a'.repeat(32), excluded = 'W13_EXCLUDED_' + 'b'.repeat(32)
const prompt = 'Reply with the synthetic memory word, or UNKNOWN if it is absent.'
const result = (word: string) => ({ session_id: 'session', subtype: 'success', is_error: false, result: word })
const assess = (message: unknown, enabled: boolean, output = '') => assessClaudeMemoryRecall(message, 'session', selected, excluded, prompt, enabled, output)
it('requires exact native recall only when enabled and preserves negative evidence', () => {
  expect(assess(result(selected), true, selected)).toMatchObject({ selectedMatched: true, excludedAbsent: true })
  expect(assess(result('UNKNOWN'), false)).toMatchObject({ selectedMatched: false, disabledAnsweredUnknown: true })
})
it.each([{ session_id: 'other' }, { subtype: 'error' }, { is_error: true }, { result: undefined }, { result: 'other' }])('rejects wrong binding/error/result %j', (change) => {
  expect(() => assess({ ...result(selected), ...change }, true)).toThrow()
})
it('cannot pass with a marker in the prompt, an excluded-memory leak or disabled marker elsewhere', () => {
  expect(() => assessClaudeMemoryRecall(result(selected), 'session', selected, excluded, selected, true, '')).toThrow()
  expect(() => assess(result(selected), true, excluded)).toThrow()
  expect(() => assess(result('UNKNOWN'), false, selected)).toThrow()
  expect(() => assess(result(selected), false)).toThrow()
})
