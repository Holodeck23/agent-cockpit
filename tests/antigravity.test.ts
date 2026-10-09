import { describe, expect, it } from 'vitest'
import { buildAntigravityArgs } from '../server/agents/antigravity/launch.ts'
import { parseAntigravityLine } from '../server/agents/antigravity/parse.ts'

const line = (value: unknown): string => JSON.stringify(value)

describe('buildAntigravityArgs', () => {
  it('uses the long-lived NDJSON protocol and resumes a named conversation', () => {
    expect(buildAntigravityArgs({
      cwd: '/project', model: 'gemini-3.8-flash-low', effort: 'medium', permissionMode: 'manual',
      resume: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
    })).toEqual([
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
      '--model', 'gemini-3.8-flash-low', '--effort', 'medium',
      '--conversation', '055a398f-db14-4c5f-abbb-1bf03f8120a7',
    ])
  })

  it('maps shared permission and effort choices onto supported Antigravity flags', () => {
    expect(buildAntigravityArgs({ cwd: '/project', effort: 'max', permissionMode: 'plan' }))
      .toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--effort', 'high', '--mode', 'plan'])
    expect(buildAntigravityArgs({ cwd: '/project', permissionMode: 'auto' })).toContain('--dangerously-skip-permissions')
    expect(buildAntigravityArgs({ cwd: '/project', permissionMode: 'acceptEdits' })).not.toContain('--dangerously-skip-permissions')
  })
})

describe('parseAntigravityLine', () => {
  it('shows a subagent hand-off (agy 1.3.1 image request, captured live) as a step', () => {
    const base = { conversation_id: '10ffd1da-3c48-4cdb-ab97-d2cfa4ab1c0b', step_index: 2, step_type: 'subagent', tool_name: 'invoke_subagent' }
    const sub = { type_name: 'image-generator', role: 'Image Generator', initial_prompt: 'Generate an image of a small blue square.' }
    expect(parseAntigravityLine(line({ event: 'step_update', step_update: { ...base, state: 'ACTIVE', subagent_info: { subagents: [sub] } } }))).toEqual([
      { kind: 'tool_use', id: 'antigravity:10ffd1da-3c48-4cdb-ab97-d2cfa4ab1c0b:2', name: 'invoke_subagent', input: { subagents: [{ role: 'Image Generator', prompt: 'Generate an image of a small blue square.' }] } },
    ])
    expect(parseAntigravityLine(line({ event: 'step_update', step_update: { ...base, state: 'DONE', duration_seconds: 0.03, subagent_info: { subagents: [sub] } } }))).toEqual([
      { kind: 'tool_result', toolUseId: 'antigravity:10ffd1da-3c48-4cdb-ab97-d2cfa4ab1c0b:2', content: 'Image Generator handed the work back', isError: false },
    ])
  })

  it('parses session metadata and streaming text', () => {
    expect(parseAntigravityLine(line({
      event: 'init', conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
      init: { cwd: '/project', model: 'gemini-3.8-flash-low' },
    }))).toEqual([{ kind: 'session', sessionId: '055a398f-db14-4c5f-abbb-1bf03f8120a7', model: 'gemini-3.8-flash-low', cwd: '/project' }])
    expect(parseAntigravityLine(line({
      event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello' },
    }))).toEqual([{ kind: 'text_delta', text: 'hello' }])
  })

  it('turns a tool lifecycle into one activity step', () => {
    const active = { conversation_id: 'c', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/project/package.json' } } }
    const done = { ...active, state: 'DONE', tool_info: { ...active.tool_info, output: '85 lines' } }
    expect(parseAntigravityLine(line({ event: 'step_update', step_update: active }))).toEqual([
      { kind: 'tool_use', id: 'antigravity:c:2', name: 'view_file', input: { AbsolutePath: '/project/package.json' } },
    ])
    expect(parseAntigravityLine(line({ event: 'step_update', step_update: done }))).toEqual([
      { kind: 'tool_result', toolUseId: 'antigravity:c:2', content: '85 lines', isError: false },
    ])
  })

  it('preserves soft-denied tool errors and terminal results', () => {
    expect(parseAntigravityLine(line({ event: 'step_update', step_update: {
      conversation_id: 'c', step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, error: { message: 'user denied permission' } },
    } }))).toEqual([{ kind: 'tool_result', toolUseId: 'antigravity:c:3', content: 'user denied permission', isError: true }])

    expect(parseAntigravityLine(line({ event: 'result', result: {
      conversation_id: 'c', status: 'SUCCESS', response: 'done\n', duration_seconds: 1.25, num_turns: 1,
    } }))).toEqual([
      { kind: 'assistant_text', messageId: 'antigravity:c:1', text: 'done\n' },
      { kind: 'result', ok: true, text: 'done\n', durationMs: 1250 },
    ])
  })

  it('ignores future events and reports malformed output without throwing', () => {
    expect(parseAntigravityLine('{nope')).toEqual([{ kind: 'error', message: 'Unparseable agent output: {nope' }])
    expect(parseAntigravityLine(line({ event: 'future' }))).toEqual([])
  })
})

describe('Antigravity and conversation images (I2)', () => {
  it('adds the conversation image folder to the workspace, since manual mode reads only the workspace', async () => {
    const { buildAntigravityArgs } = await import('../server/agents/antigravity/launch.ts')
    const args = buildAntigravityArgs({ cwd: '/p', imagesDir: '/state/attachments/t1' })
    expect(args.slice(-2)).toEqual(['--add-dir', '/state/attachments/t1'])
    expect(buildAntigravityArgs({ cwd: '/p' })).not.toContain('--add-dir')
  })
})
