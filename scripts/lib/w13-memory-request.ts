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

/** Classify a documented SQLite-directory override without assuming it redirects memory files. */
export function assessNativeMemoryRootControl(request: unknown, credentialHomeMarker: string, sqliteHomeMarker: string, prompt: string): {
  memorySource: 'credential-home' | 'sqlite-home'; isolatedMemoryRootObserved: boolean
} {
  assert.ok(credentialHomeMarker.length >= 32 && sqliteHomeMarker.length >= 32 && credentialHomeMarker !== sqliteHomeMarker)
  assert.ok(!prompt.includes(credentialHomeMarker) && !prompt.includes(sqliteHomeMarker), 'Prompt contains a root-control canary')
  assert.ok(request && typeof request === 'object' && !Array.isArray(request))
  const body = request as { input?: unknown; instructions?: unknown }
  assert.ok(Array.isArray(body.input) || typeof body.input === 'string', 'No native model input')
  const context = JSON.stringify({ input: body.input, instructions: body.instructions })
  const credentialLoaded = context.includes(credentialHomeMarker), sqliteLoaded = context.includes(sqliteHomeMarker)
  assert.notEqual(credentialLoaded, sqliteLoaded, 'Expected exactly one native memory root in the control')
  return { memorySource: sqliteLoaded ? 'sqlite-home' : 'credential-home', isolatedMemoryRootObserved: sqliteLoaded }
}

/** An empty v2 context is an observation, never a successful memory-loading proof. */
export function observeNativeV2MemoryRoots(request: unknown, credentialHomeMarker: string, sqliteHomeMarker: string, prompt: string,
  additionalRoots: Record<string, string> = {}): {
  credentialHomeLoaded: boolean; sqliteHomeLoaded: boolean; memoryLoadingDemonstrated: boolean; loadedRoots: string[]
} {
  assert.ok(credentialHomeMarker.length >= 32 && sqliteHomeMarker.length >= 32 && credentialHomeMarker !== sqliteHomeMarker)
  assert.ok(!prompt.includes(credentialHomeMarker) && !prompt.includes(sqliteHomeMarker), 'Prompt contains a memory canary')
  assert.ok(request && typeof request === 'object' && !Array.isArray(request))
  const body = request as { input?: unknown; instructions?: unknown }
  assert.ok(Array.isArray(body.input) || typeof body.input === 'string')
  const context = JSON.stringify({ input: body.input, instructions: body.instructions })
  const credentialHomeLoaded = context.includes(credentialHomeMarker), sqliteHomeLoaded = context.includes(sqliteHomeMarker)
  const roots = { 'credential-v1': credentialHomeMarker, 'sqlite-v1': sqliteHomeMarker, ...additionalRoots }
  assert.equal(Object.keys(roots).length, Object.keys(additionalRoots).length + 2, 'Reserved root alias reused')
  assert.ok(Object.values(roots).every((marker) => marker.length >= 32 && !prompt.includes(marker)))
  assert.equal(new Set(Object.values(roots)).size, Object.keys(roots).length)
  const loadedRoots = Object.entries(roots).filter(([, marker]) => context.includes(marker)).map(([alias]) => alias)
  assert.ok(loadedRoots.length <= 1, 'Multiple memory roots appeared')
  return { credentialHomeLoaded, sqliteHomeLoaded, memoryLoadingDemonstrated: loadedRoots.length === 1, loadedRoots }
}
