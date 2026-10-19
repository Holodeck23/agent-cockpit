import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedMemoryThreadConfig, nativeMemoryCall, nativeMemoryResult, nativeMemoryTrace, nativeMemoryProgram, nativeMemorySnapshot } from '../scripts/lib/w13-native-memory-overlay.ts'

it('disables all resolved MCP names without copying their transports or secrets', () => {
  const result = isolatedMemoryThreadConfig({ config: { mcp_servers: { 'server.with.dots': { command: 'unreviewed', env: { SECRET: 'private' } } } },
    layers: [{ name: { type: 'user', file: '/fixture/config.toml' } }, { name: { type: 'project', dot_codex_folder: '/fixture/repo/.codex' } }, { name: { type: 'sessionFlags' } }] })
  expect(result).toEqual({ config: { mcp_servers: { 'server.with.dots': { enabled: false } } }, sourceFiles: ['/fixture/config.toml', '/fixture/repo/.codex/config.toml'] })
})
it('fails closed on unknown, dynamic or malformed effective configuration sources', () => {
  for (const response of [{}, { config: {}, layers: [{ name: { type: 'enterpriseManaged' } }] },
    { config: {}, layers: [{ name: { type: 'user', file: 'relative.toml' } }] }, { config: { mcp_servers: [] }, layers: [] },
    { config: { mcpServers: {} }, layers: [] }, { config: { mcp_servers: { bad: null } }, layers: [] }]) {
    expect(() => isolatedMemoryThreadConfig(response)).toThrow()
  }
})

const tool = { type: 'namespace', name: 'memories', tools: [{ type: 'function', name: 'read', parameters: { properties: { path: {} } } }] }
it('selects the exact native namespace and binds the generated call', () => {
  expect(nativeMemoryCall([tool], 'read', 'call', { path: 'MEMORY.md' })).toMatchObject({ namespace: 'memories', name: 'read', call_id: 'call' })
  expect(nativeMemoryCall([{ type: 'function', name: 'memories__read', parameters: { properties: { path: {} } } }], 'read', 'call', {})).toMatchObject({ name: 'memories__read' })
})
it('refuses missing, ambiguous or unrelated tool definitions', () => {
  for (const tools of [undefined, [], [tool, tool], [{ ...tool, name: 'unselected' }], [{ ...tool, tools: [{ ...tool.tools[0], parameters: {} }] }]]) {
    expect(() => nativeMemoryCall(tools, 'read', 'call', {})).toThrow()
  }
})
it('requires actual persisted content in the matching native tool result', () => {
  const result = { type: 'function_call_output', call_id: 'read', output: [{ type: 'input_text', text: 'persisted note' }] }
  expect(() => nativeMemoryResult({ input: [result] }, 'read', 'persisted note')).not.toThrow()
  for (const input of [[], [result, result], [{ ...result, call_id: 'other' }], [{ ...result, output: 'missing' }],
    [{ type: 'function_call', call_id: 'read', arguments: 'persisted note' }], [{ role: 'assistant', content: 'persisted note' }]]) {
    expect(() => nativeMemoryResult({ input }, 'read', 'persisted note')).toThrow()
  }
})

it('binds live native tool observations to thread, turn, namespace and persisted read output', () => {
  const event = (item: unknown) => ({ threadId: 'thread', turnId: 'turn', item })
  const call = { type: 'function_call', namespace: 'memories', name: 'read', call_id: 'call', arguments: JSON.stringify({ path: 'extensions/ad_hoc/notes/file.md' }) }
  const output = { type: 'function_call_output', call_id: 'call', output: 'persisted marker' }
  expect(nativeMemoryTrace([event(call), event(output)], 'thread', 'turn', 'read', 'file.md', 'persisted marker')).toEqual({ callId: 'call', itemCount: 2, route: 'direct' })
  for (const events of [[{ ...event(call), threadId: 'other' }, event(output)], [event(call), { ...event(output), turnId: 'other' }],
    [event({ ...call, namespace: 'mcp_unreviewed' }), event(output)], [event(call), event({ ...output, call_id: 'unbound' })],
    [event(call), event(call), event(output)], [event({ type: 'message', content: 'persisted marker' }), event(call), event(output)]]) {
    expect(() => nativeMemoryTrace(events, 'thread', 'turn', 'read', 'file.md', 'persisted marker')).toThrow()
  }
})

it('retains file mutations while recording links without reading outside their memory root', () => {
  const root = mkdtempSync(join(tmpdir(), 'w13-memory-snapshot-'))
  const outside = mkdtempSync(join(tmpdir(), 'w13-memory-outside-'))
  try {
    writeFileSync(join(root, 'note.md'), 'first')
    writeFileSync(join(outside, 'private.md'), 'outside-first')
    symlinkSync(outside, join(root, 'linked'))
    symlinkSync(join(outside, 'absent'), join(root, 'dangling'))
    const before = nativeMemorySnapshot(root)
    writeFileSync(join(outside, 'private.md'), 'outside-changed')
    expect(nativeMemorySnapshot(root)).toEqual(before)
    writeFileSync(join(root, 'note.md'), 'changed')
    expect(nativeMemorySnapshot(root)).not.toEqual(before)
    expect(nativeMemorySnapshot(join(root, 'absent'))).toEqual({ '': 'absent' })
    expect(before.dangling).toContain('untraversed-symlink:')
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

it('permits only the exact source-owned code-mode memory program and its bound tagged result', () => {
  const event = (item: unknown) => ({ threadId: 'thread', turnId: 'turn', item })
  const program = nativeMemoryProgram('read', 'file.md', 'persisted marker')
  expect(program).not.toContain('persisted marker')
  const call = { type: 'custom_tool_call', name: 'exec', call_id: 'call', input: program }
  const output = { type: 'custom_tool_call_output', call_id: 'call', output: '{"w13NativeMemoryResult":"persisted marker"}' }
  expect(nativeMemoryTrace([event(call), event(output)], 'thread', 'turn', 'read', 'file.md', 'persisted marker').route).toBe('approved-code-mode-program')
  for (const input of [program + '; await tools.unreviewed()', 'text("persisted marker")', 'await import("fs")', program.replace('memories__read', 'mcp__read')]) {
    expect(() => nativeMemoryTrace([event({ ...call, input }), event(output)], 'thread', 'turn', 'read', 'file.md', 'persisted marker')).toThrow()
  }
  expect(() => nativeMemoryTrace([event(call), event({ ...output, output: 'failed to spawn code-mode host' })], 'thread', 'turn', 'read', 'file.md', 'persisted marker')).toThrow()
  expect(() => nativeMemoryProgram('write', '../outside.md', 'note')).toThrow()
})
