// Synthetic Claude Code and Codex session files in the shapes the CLIs write (record types and keys
// copied from real files; every value made up). Used by tests/import.test.ts and proof-import.ts.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProjectDir } from '../../server/import/sessions.ts'

export const CLAUDE_SESSION = '0f6c2b8e-1d3a-4c5b-9e7f-2a1b3c4d5e6f'
export const CODEX_SESSION = '01a0f639-0838-7c03-82e2-1dff983fe1e9'

const lines = (...rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`

export function claudeSessionText(cwd: string): string {
  const base = { cwd, sessionId: CLAUDE_SESSION, isSidechain: false, userType: 'external', version: '2.1.0', gitBranch: 'main' }
  return lines(
    { type: 'queue-operation', operation: 'enqueue', sessionId: CLAUDE_SESSION, timestamp: '2026-09-30T09:00:00.000Z' },
    { ...base, type: 'user', uuid: 'u1', timestamp: '2026-09-30T09:00:01.000Z', message: { role: 'user', content: 'Add a dark mode toggle to the header' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-09-30T09:00:03.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }] } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-09-30T09:00:04.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Looking at the header first.' }] } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: '2026-09-30T09:00:05.000Z', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${cwd}/src/Header.tsx` } }] } },
    { ...base, type: 'user', uuid: 'u2', timestamp: '2026-09-30T09:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function Header() {}' }] } },
    { ...base, isSidechain: true, type: 'assistant', uuid: 's1', timestamp: '2026-09-30T09:00:07.000Z', message: { id: 'msg_s', role: 'assistant', content: [{ type: 'text', text: 'Side chain from a sub-agent.' }] } },
    { ...base, type: 'assistant', uuid: 'a4', timestamp: '2026-09-30T09:00:09.000Z', message: { id: 'msg_3', role: 'assistant', content: [{ type: 'text', text: 'Added the toggle; it remembers the choice.' }] } },
    { ...base, type: 'user', uuid: 'u3', timestamp: '2026-09-30T09:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] } },
    { ...base, type: 'user', uuid: 'u4', timestamp: '2026-09-30T09:05:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Now make it follow the system setting' }] } },
    { ...base, type: 'assistant', uuid: 'a5', timestamp: '2026-09-30T09:05:04.000Z', message: { id: 'msg_4', role: 'assistant', content: [{ type: 'text', text: 'Done: it follows the system until you pick one.' }] } },
    { type: 'last-prompt', lastPrompt: 'Now make it follow the system setting', sessionId: CLAUDE_SESSION },
  )
}

export function codexSessionText(cwd: string): string {
  const meta = { type: 'session_meta', timestamp: '2026-10-01T08:48:47.000Z', ordinal: 0,
    payload: { id: CODEX_SESSION, session_id: CODEX_SESSION, cwd, cli_version: '0.50.0', originator: 'codex_cli', source: 'cli', base_instructions: 'You are Codex.' } }
  const item = (ordinal: number, timestamp: string, payload: unknown) => ({ type: 'response_item', ordinal, timestamp, payload })
  return lines(
    meta,
    { type: 'event_msg', ordinal: 1, timestamp: '2026-10-01T08:48:48.000Z', payload: { type: 'task_started', turn_id: 't1' } },
    item(2, '2026-10-01T08:48:48.100Z', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox rules.' }] }),
    item(3, '2026-10-01T08:48:48.200Z', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '# AGENTS.md instructions for this folder\n\nUse pnpm.' },
      { type: 'input_text', text: '<environment_context>\n  <cwd>somewhere</cwd>\n</environment_context>' },
      { type: 'input_text', text: 'Why is the build slow?' }] }),
    item(4, '2026-10-01T08:48:50.000Z', { type: 'reasoning', summary: [], content: null, encrypted_content: 'x' }),
    item(5, '2026-10-01T08:48:51.000Z', { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd: 'npm run build -- --profile' }) }),
    item(6, '2026-10-01T08:48:58.000Z', { type: 'function_call_output', call_id: 'call_1', output: 'built in 41.2s' }),
    item(7, '2026-10-01T08:48:59.000Z', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_2', input: '*** Begin Patch' }),
    item(8, '2026-10-01T08:49:00.000Z', { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Success' }),
    item(9, '2026-10-01T08:49:01.000Z', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Source maps were on in production; turned them off.' }] }),
    { type: 'event_msg', ordinal: 10, timestamp: '2026-10-01T08:49:01.500Z', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 13000 } },
  )
}

/** Moves every timestamp so the earliest is `start` (ms), keeping the gaps between them. */
function startingAt(text: string, start: number | undefined): string {
  if (start === undefined) return text
  const stamps = [...text.matchAll(/"timestamp":"([^"]+)"/g)].map((m) => Date.parse(m[1]!))
  const shift = start - Math.min(...stamps)
  return text.replace(/"timestamp":"([^"]+)"/g, (_m, iso: string) => `"timestamp":"${new Date(Date.parse(iso) + shift).toISOString()}"`)
}

/**
 * Writes both into a fake home: ~/.claude/projects/<encoded>/<id>.jsonl and ~/.codex/sessions/2026/10/01/rollout-….jsonl.
 * `start` moves the sessions' times (e.g. to two hours ago), so screenshots show ordinary local times.
 */
export function writeImportHome(home: string, projectPath: string, start?: number): void {
  const claude = claudeProjectDir(home, projectPath)
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, `${CLAUDE_SESSION}.jsonl`), startingAt(claudeSessionText(projectPath), start))
  const codex = join(home, '.codex', 'sessions', '2026', '10', '01')
  mkdirSync(codex, { recursive: true })
  writeFileSync(join(codex, `rollout-2026-10-01T08-48-47-${CODEX_SESSION}.jsonl`), startingAt(codexSessionText(projectPath), start))
  // A session from another folder that must never be listed.
  writeFileSync(join(codex, 'rollout-2026-10-01T09-00-00-other.jsonl'), codexSessionText('/some/other/project'))
}
