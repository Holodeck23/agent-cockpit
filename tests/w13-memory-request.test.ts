import { expect, it } from 'vitest'
import { assessNativeMemoryRequest, assessNativeMemoryRootControl, observeNativeV2MemoryRoots } from '../scripts/lib/w13-memory-request.ts'

const selected = 'selected-memory-' + 'a'.repeat(32), excluded = 'excluded-memory-' + 'b'.repeat(32)
const prompt = 'Reply without tools using the synthetic memory if available.'
it('keeps an empty v2 context explicitly unproved and distinguishes a real native root observation', () => {
  expect(observeNativeV2MemoryRoots({ input: prompt, metadata: excluded }, selected, excluded, prompt))
    .toEqual({ credentialHomeLoaded: false, sqliteHomeLoaded: false, memoryLoadingDemonstrated: false, loadedRoots: [] })
  expect(observeNativeV2MemoryRoots({ input: prompt, instructions: excluded }, selected, excluded, prompt))
    .toEqual({ credentialHomeLoaded: false, sqliteHomeLoaded: true, memoryLoadingDemonstrated: true, loadedRoots: ['sqlite-v1'] })
})
it('attributes a v2-layout canary only to its distinct root and rejects aliases or marker collisions', () => {
  const v2 = 'v2-root-' + 'c'.repeat(32)
  expect(observeNativeV2MemoryRoots({ input: v2 }, selected, excluded, prompt, { 'sqlite-v2-direct': v2 }))
    .toMatchObject({ memoryLoadingDemonstrated: true, loadedRoots: ['sqlite-v2-direct'] })
  expect(() => observeNativeV2MemoryRoots({ input: v2 }, selected, excluded, prompt, { 'credential-v1': v2 })).toThrow()
  expect(() => observeNativeV2MemoryRoots({ input: selected }, selected, excluded, prompt, { other: selected })).toThrow()
  expect(() => observeNativeV2MemoryRoots({ input: [v2, selected] }, selected, excluded, prompt, { other: v2 })).toThrow()
  expect(() => observeNativeV2MemoryRoots({ input: v2 }, selected, excluded, v2, { other: v2 })).toThrow()
})
it('does not accept mixed roots, missing native input or a prompt-seeded v2 canary', () => {
  expect(() => observeNativeV2MemoryRoots({ input: [selected, excluded] }, selected, excluded, prompt)).toThrow()
  expect(() => observeNativeV2MemoryRoots({ metadata: selected }, selected, excluded, prompt)).toThrow()
  expect(() => observeNativeV2MemoryRoots({ input: selected }, selected, excluded, selected)).toThrow()
})
it('classifies credential-home and SQLite-home memory without treating either observation as parity', () => {
  expect(assessNativeMemoryRootControl({ input: selected }, selected, excluded, prompt))
    .toEqual({ memorySource: 'credential-home', isolatedMemoryRootObserved: false })
  expect(assessNativeMemoryRootControl({ input: prompt, instructions: excluded }, selected, excluded, prompt))
    .toEqual({ memorySource: 'sqlite-home', isolatedMemoryRootObserved: true })
})
it('rejects inconclusive roots, both roots, metadata-only evidence and prompt-seeded canaries', () => {
  for (const request of [{ input: prompt }, { input: [selected, excluded] }, { metadata: selected, input: prompt }, null]) {
    expect(() => assessNativeMemoryRootControl(request, selected, excluded, prompt)).toThrow()
  }
  expect(() => assessNativeMemoryRootControl({ input: selected }, selected, excluded, selected)).toThrow()
  expect(() => assessNativeMemoryRootControl({ input: selected }, selected, selected, prompt)).toThrow()
})
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
