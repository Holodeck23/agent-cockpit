import { expect, it } from 'vitest'
import { isolatedMemoryThreadConfig, nativeMemoryCall, nativeMemoryResult } from '../scripts/lib/w13-native-memory-overlay.ts'

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
