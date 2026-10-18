import assert from 'node:assert/strict'

export type InstructionSource = { file: string; parent?: string }

/** Native loader events plus a separate no-tools behavioral check. No source content is supplied in the prompt. */
export function assessClaudeInstructions(message: any, sessionId: string, sources: InstructionSource[],
  events: any[], words: string[], rootShared: string, excluded: string, prompt: string, nativeOutput: string): Record<string, unknown> {
  assert.ok(sources.length >= 3 && new Set(sources.map((source) => source.file)).size === sources.length)
  assert.equal(words.length, 4)
  assert.ok([...words, rootShared, excluded].every((word) => word.length >= 24 && !prompt.includes(word)))
  assert.equal(new Set([...words, rootShared, excluded]).size, 6)
  assert.equal(message.session_id, sessionId); assert.equal(message.subtype, 'success'); assert.equal(message.is_error, false)
  assert.equal(typeof message.result, 'string')
  const lines = message.result.trim().split('\n')
  assert.deepEqual(lines.slice(0, 3), words.slice(0, 3), 'Native root/import/nested words did not match')
  const shared = lines.slice(3)
  assert.ok(shared.length >= 1 && shared.length <= 2 && new Set(shared).size === shared.length
    && shared.every((word: string) => [rootShared, words[3]].includes(word)), 'Unrecognized shared-selection result')
  assert.ok(!nativeOutput.includes(excluded), 'Sibling instruction canary appeared')
  for (const source of sources) {
    const matches = events.filter((event) => event.file_path === source.file)
    assert.ok(matches.length > 0, 'No native loaded-source event for an expected instruction file')
    assert.ok(matches.every((event) => event.hook_event_name === 'InstructionsLoaded'
      && event.session_id === sessionId && event.memory_type === 'Project'
      && (source.parent ? event.load_reason === 'include' && event.parent_file_path === source.parent
        : ['session_start', 'nested_traversal'].includes(event.load_reason))), 'Loaded instruction provenance differs')
  }
  return { expectedNativeSourcesObserved: sources.length, relativeImportParentObserved: true,
    rootAndImportAndNestedWordsMatched: true, siblingCanaryAbsent: true,
    sharedSelection: shared.length === 2 ? 'CONFLICT_BOTH_REPORTED' : shared[0] === words[3] ? 'NESTED_VALUE_REPORTED' : 'ROOT_VALUE_REPORTED',
    deterministicCollisionPrecedenceEstablished: false }
}
