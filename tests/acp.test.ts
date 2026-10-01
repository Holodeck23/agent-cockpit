import { describe, expect, it } from 'vitest'
import { acpTool, acpTurnEnd, parseAcpUpdate } from '../server/agents/acp/parse.ts'
import { opencodeConfig, opencodePermission } from '../server/agents/opencode/launch.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// Shapes from the Agent Client Protocol schema (agentclientprotocol.com): session/update params.
const update = (u: Record<string, unknown>) => ({ sessionId: 's1', update: u })

describe('ACP updates', () => {
  it('collects message text as chunks', () => {
    expect(parseAcpUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } }))).toEqual({ type: 'text', text: 'Hel' })
    expect(parseAcpUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }))).toEqual({ type: 'ignore' })
  })

  it('names tool calls like the other agents, and closes them on completion or failure', () => {
    expect(parseAcpUpdate(update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } })))
      .toEqual({ type: 'events', events: [{ kind: 'tool_use', id: 'c1', name: 'Shell', input: { command: 'npm test' } }] })
    expect(parseAcpUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '3 passed' } }] })))
      .toEqual({ type: 'events', events: [{ kind: 'tool_result', toolUseId: 'c1', content: '3 passed', isError: false }] })
    expect(parseAcpUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' }))).toEqual({ type: 'ignore' })
    expect(parseAcpUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', rawOutput: 'denied' })))
      .toEqual({ type: 'events', events: [{ kind: 'tool_result', toolUseId: 'c1', content: 'denied', isError: true }] })
  })

  it('maps kinds and locations onto file, search and fetch steps', () => {
    expect(acpTool({ kind: 'edit', title: 'Edit', locations: [{ path: '/p/a.ts' }] })).toEqual({ name: 'Edit', input: { file_path: '/p/a.ts' } })
    expect(acpTool({ kind: 'read', title: 'Read', rawInput: { filePath: '/p/b.ts' } })).toEqual({ name: 'Read', input: { file_path: '/p/b.ts' } })
    expect(acpTool({ kind: 'search', title: 'Find TODO', rawInput: { pattern: 'TODO' } })).toEqual({ name: 'Grep', input: { pattern: 'TODO' } })
    expect(acpTool({ kind: 'other', title: 'cockpit_recall', rawInput: { query: 'x' } })).toEqual({ name: 'cockpit_recall', input: { query: 'x' } })
  })

  it('leaves thoughts and plans out, and ends turns by stop reason', () => {
    expect(parseAcpUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }))).toEqual({ type: 'ignore' })
    expect(parseAcpUpdate(update({ sessionUpdate: 'plan', entries: [] }))).toEqual({ type: 'ignore' })
    expect(acpTurnEnd('end_turn')).toEqual({ kind: 'result', ok: true })
    expect(acpTurnEnd('cancelled')).toEqual({ kind: 'result', ok: false, stopped: true })
    expect(acpTurnEnd('refusal')).toEqual({ kind: 'result', ok: false })
  })
})

describe('OpenCode config', () => {
  it('maps Cockpit permissions onto ask/allow/deny per tool', () => {
    expect(opencodePermission('manual')).toEqual({ edit: 'ask', bash: 'ask', webfetch: 'ask' })
    expect(opencodePermission('plan')).toEqual({ edit: 'deny', bash: 'ask', webfetch: 'ask' })
    expect(opencodePermission('acceptEdits')).toEqual({ edit: 'allow', bash: 'ask', webfetch: 'ask' })
    expect(opencodePermission('bypassPermissions')).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' })
  })

  it('passes an OpenRouter model through, and nothing when blank', () => {
    expect(JSON.parse(opencodeConfig({ model: 'openrouter/openai/gpt-4o:free', permissionMode: 'manual' }))).toMatchObject({ model: 'openrouter/openai/gpt-4o:free' })
    expect(JSON.parse(opencodeConfig({ permissionMode: 'manual' }))).not.toHaveProperty('model')
  })

  it('accepts provider/model names in conversation settings', () => {
    expect(threadSettingsSchema.parse({ agent: 'opencode', model: 'openrouter/anthropic/claude-sonnet-4' }).model).toBe('openrouter/anthropic/claude-sonnet-4')
    expect(() => threadSettingsSchema.parse({ model: 'bad model; rm -rf' })).toThrow()
  })
})
