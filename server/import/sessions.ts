import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, NormalizedEvent } from '../agents/types.ts'
import type { StoredEvent } from '../threads/types.ts'

// Import conversations (U8, asked for after Mark Kashef's question): a project's existing Claude Code
// and Codex sessions, read from the CLIs' own JSONL files, become Cockpit conversations that keep
// the original session id, so the next message resumes the same CLI session.
//  - Claude Code: ~/.claude/projects/<project path with every non-alphanumeric as "-">/<session id>.jsonl
//  - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl whose session_meta cwd is the project
// Source files are only ever read. Injected context (environment blocks, command echoes, sub-agent
// side chains, reasoning) is left out; messages and tool steps keep their original times.

export interface SessionSummary {
  readonly agent: AgentId
  readonly sessionId: string
  /** The first thing you asked, for the list. */
  readonly firstPrompt: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly messages: number
}
export interface ImportedSession extends SessionSummary { readonly events: StoredEvent[] }

/** macOS /var and /private/var (and a user's project symlinks) can name the same folder. */
function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return path }
}
export function sameProjectPath(left: string, right: string): boolean {
  return left === right || canonicalPath(left) === canonicalPath(right)
}

const MAX_FILE_BYTES = 50 * 1024 * 1024
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
/** Text the CLI injected rather than the person typed: wrapped context blocks, command echoes, caveats. */
const injected = (text: string): boolean => {
  const t = text.trimStart()
  return t === '' || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('# AGENTS.md')
}
const asText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

/** Adds a turn's end (a successful result) before each later message of yours and at the end. */
function withTurnEnds(events: StoredEvent[]): StoredEvent[] {
  const out: StoredEvent[] = []
  let open = false
  for (const e of events) {
    if (e.event.kind === 'user_text' && open) out.push({ ts: e.ts, event: { kind: 'result', ok: true } })
    if (e.event.kind === 'user_text') open = true
    if (e.event.kind === 'result') open = false
    out.push(e)
  }
  if (open && out.at(-1)?.event.kind !== 'result') out.push({ ts: out.at(-1)!.ts, event: { kind: 'result', ok: true } })
  return out
}

function summarize(agent: AgentId, sessionId: string, events: StoredEvent[], updatedAt: string): ImportedSession {
  const first = events.find((e) => e.event.kind === 'user_text')?.event
  return {
    agent, sessionId, events, updatedAt,
    firstPrompt: first?.kind === 'user_text' ? clip(first.text.replace(/\s+/g, ' ').trim(), 140) : '(no message)',
    startedAt: events[0]?.ts ?? updatedAt,
    messages: events.filter((e) => e.event.kind === 'user_text' || e.event.kind === 'assistant_text').length,
  }
}

// ---------- Claude Code ----------

export const claudeProjectDir = (home: string, projectPath: string): string =>
  join(home, '.claude', 'projects', projectPath.replace(/[^A-Za-z0-9]/g, '-'))

/** One Claude Code session file as Cockpit events. Lines from other folders, without a folder, or side chains are skipped. */
export function readClaudeSession(text: string, sessionId: string, projectPath: string, updatedAt: string): ImportedSession {
  const events: StoredEvent[] = []
  const matchingPaths = new Set([projectPath, canonicalPath(projectPath)])
  const push = (ts: unknown, event: NormalizedEvent): void => { events.push({ ts: typeof ts === 'string' ? ts : updatedAt, event }) }
  for (const line of text.split('\n')) {
    const row = parse(line)
    if (!row || (row.type !== 'user' && row.type !== 'assistant') || row.isSidechain === true || row.isMeta === true) continue
    // Every message Claude Code writes names its folder. One that does not could have been put
    // there by anything that can write in ~/.claude, and dashed folder names can collide.
    if (typeof row.cwd !== 'string') continue
    if (!matchingPaths.has(row.cwd)) {
      if (!sameProjectPath(row.cwd, projectPath)) continue
      matchingPaths.add(row.cwd)
    }
    const message = (row.message ?? {}) as { id?: string; content?: unknown }
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []
    if (row.type === 'user') {
      const typed = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && !injected(b.text as string)).map((b) => b.text as string)
      if (typed.length) push(row.timestamp, { kind: 'user_text', text: typed.join('\n\n') })
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const content = Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n') : asText(b.content)
        push(row.timestamp, { kind: 'tool_result', toolUseId: String(b.tool_use_id ?? ''), content: clip(content, 4000), isError: b.is_error === true })
      }
    } else {
      blocks.forEach((b, i) => {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) push(row.timestamp, { kind: 'assistant_text', messageId: `${message.id ?? row.uuid ?? 'm'}-${i}`, text: b.text })
        if (b.type === 'tool_use') push(row.timestamp, { kind: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? 'tool'), input: b.input ?? {} })
      })
    }
  }
  return summarize('claude', sessionId, withTurnEnds(events), updatedAt)
}

export function listClaudeSessions(home: string, projectPath: string, limit = Infinity): ImportedSession[] {
  const dirs = [...new Set([projectPath, canonicalPath(projectPath)].map((path) => claudeProjectDir(home, path)))].filter(existsSync)
  const seen = new Set<string>()
  return dirs.flatMap((dir) => readdirSync(dir).filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n))
    .map((name) => ({ name, file: join(dir, name), stat: statSync(join(dir, name)) })))
    .filter(({ stat }) => stat.isFile() && stat.size <= MAX_FILE_BYTES)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit).flatMap(({ name, file, stat }) => {
    const session = readClaudeSession(readFileSync(file, 'utf8'), name.slice(0, -'.jsonl'.length), projectPath, stat.mtime.toISOString())
    if (!session.messages || seen.has(session.sessionId)) return []
    seen.add(session.sessionId)
    return [session]
  })
}

// ---------- Codex ----------

const SHELL_TOOLS = new Set(['shell', 'exec_command', 'local_shell', 'container.exec'])

/** One Codex rollout file as Cockpit events, or undefined when it belongs to another folder. */
export function readCodexSession(text: string, projectPath: string, updatedAt: string): ImportedSession | undefined {
  const events: StoredEvent[] = []
  let sessionId: string | undefined
  const push = (ts: unknown, event: NormalizedEvent): void => { events.push({ ts: typeof ts === 'string' ? ts : updatedAt, event }) }
  for (const line of text.split('\n')) {
    const row = parse(line)
    const p = (row?.payload ?? {}) as Record<string, unknown>
    if (!row) continue
    if (row.type === 'session_meta') {
      if (typeof p.cwd !== 'string' || !sameProjectPath(p.cwd, projectPath)) return undefined
      sessionId = typeof p.id === 'string' ? p.id : undefined
      continue
    }
    if (row.type === 'event_msg' && p.type === 'task_complete') {
      push(row.timestamp, { kind: 'result', ok: true, ...(typeof p.duration_ms === 'number' ? { durationMs: p.duration_ms } : {}) })
      continue
    }
    if (row.type !== 'response_item') continue
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const parts = (Array.isArray(p.content) ? p.content : []) as Array<{ type?: string; text?: string }>
      const texts = parts.filter((c) => (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string').map((c) => c.text as string)
      if (p.role === 'user') {
        const typed = texts.filter((t) => !injected(t))
        if (typed.length) push(row.timestamp, { kind: 'user_text', text: typed.join('\n\n') })
      } else if (texts.join('').trim()) push(row.timestamp, { kind: 'assistant_text', messageId: String(p.id ?? row.timestamp), text: texts.join('\n\n') })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const name = String(p.name ?? 'tool')
      let input: unknown = p.type === 'function_call' ? p.arguments : { input: p.input }
      if (typeof input === 'string') input = parse(input) ?? { input }
      const args = (input ?? {}) as Record<string, unknown>
      const command = Array.isArray(args.command) ? args.command.join(' ') : typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : undefined
      const tool = SHELL_TOOLS.has(name) && command ? { name: 'Shell', input: { command } } : name === 'apply_patch' ? { name: 'Edit', input: {} } : { name, input }
      push(row.timestamp, { kind: 'tool_use', id: String(p.call_id ?? ''), ...tool })
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const output = typeof p.output === 'object' && p.output !== null && 'content' in p.output ? (p.output as { content: unknown }).content : p.output
      push(row.timestamp, { kind: 'tool_result', toolUseId: String(p.call_id ?? ''), content: clip(asText(output), 4000), isError: false })
    }
  }
  return sessionId ? summarize('codex', sessionId, withTurnEnds(events), updatedAt) : undefined
}

/** The first line (session_meta) names the folder; reading only it keeps the scan cheap. */
function firstLine(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(512 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    const end = text.indexOf('\n')
    return end === -1 ? text : text.slice(0, end)
  } finally {
    closeSync(fd)
  }
}

export function listCodexSessions(home: string, projectPath: string, limit = Infinity): ImportedSession[] {
  const root = join(home, '.codex', 'sessions')
  if (!existsSync(root)) return []
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && depth < 3) walk(join(dir, entry.name), depth + 1)
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  walk(root, 0)
  return files.flatMap((file) => {
    const meta = parse(firstLine(file))
    const payload = (meta?.payload ?? {}) as Record<string, unknown>
    const stat = statSync(file)
    if (meta?.type !== 'session_meta' || (typeof payload.cwd !== 'string' || !sameProjectPath(payload.cwd, projectPath)) || stat.size > MAX_FILE_BYTES) return []
    return [{ file, stat }]
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit).flatMap(({ file, stat }) => {
    const session = readCodexSession(readFileSync(file, 'utf8'), projectPath, stat.mtime.toISOString())
    return session && session.messages > 0 ? [session] : []
  })
}

/** Every importable session for the project, newest first. */
export function listSessions(home: string, projectPath: string, limit = Infinity): ImportedSession[] {
  return [...listClaudeSessions(home, projectPath, limit), ...listCodexSessions(home, projectPath, limit)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}
