import assert from 'node:assert/strict'

/** Fresh no-tools session only. Synthetic canaries never enter the user prompt. */
export function assessClaudeMemoryRecall(message: any, sessionId: string, selected: string, excluded: string,
  prompt: string, enabled: boolean, nativeOutput: string): { selectedMatched: boolean; excludedAbsent: true; disabledAnsweredUnknown: boolean } {
  assert.ok(selected.length >= 24 && excluded.length >= 24 && selected !== excluded)
  assert.ok(!prompt.includes(selected) && !prompt.includes(excluded), 'Prompt leaked a memory canary')
  assert.equal(message.session_id, sessionId)
  assert.equal(message.subtype, 'success'); assert.equal(message.is_error, false)
  assert.equal(typeof message.result, 'string')
  assert.equal(message.result.trim(), enabled ? selected : 'UNKNOWN')
  assert.ok(!nativeOutput.includes(excluded), 'Unselected canary appeared in native output')
  if (!enabled) assert.ok(!nativeOutput.includes(selected), 'Disabled canary appeared in native output')
  return { selectedMatched: enabled, excludedAbsent: true, disabledAnsweredUnknown: !enabled }
}
