import assert from 'node:assert/strict'

/** Native request-context observation only: no claim of model recall, account parity or writeback. */
export function assessNativeMemoryRequest(request: unknown, selected: string, excluded: string, prompt: string, enabled = true): {
  readonly selectedLoaded: boolean; readonly excludedAbsent: true; readonly modelContextChars: number
} {
  assert.ok(selected.length >= 32 && excluded.length >= 32 && selected !== excluded)
  assert.ok(!prompt.includes(selected) && !prompt.includes(excluded), 'The prompt contains a memory canary')
  assert.ok(request && typeof request === 'object' && !Array.isArray(request))
  const body = request as { input?: unknown; instructions?: unknown }
  assert.ok(Array.isArray(body.input) || typeof body.input === 'string', 'No native model input')
  const context = JSON.stringify({ input: body.input, instructions: body.instructions })
  assert.equal(context.includes(selected), enabled, enabled ? 'The native request did not contain selected memory' : 'The native request exposed disabled memory')
  assert.ok(!context.includes(excluded), 'The native request exposed unselected memory')
  return { selectedLoaded: enabled, excludedAbsent: true, modelContextChars: context.length }
}
