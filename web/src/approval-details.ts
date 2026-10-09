import type { AgentId } from '../../server/agents/types.ts'

const object = (input: unknown): Record<string, unknown> => input && typeof input === 'object' ? input as Record<string, unknown> : {}

export function requestedEdit(input: unknown): { before: string; after: string; all: boolean } | undefined {
  const value = object(input)
  return typeof value.old_string === 'string' && typeof value.new_string === 'string'
    ? { before: value.old_string, after: value.new_string, all: value.replace_all === true } : undefined
}

/** A lexical path warning, never a substitute for the host's filesystem permission checks. */
export function outsideWorkspace(input: unknown, cwd?: string): boolean {
  const value = object(input)
  const path = value.file_path ?? value.path
  if (!cwd?.startsWith('/') || typeof path !== 'string') return false
  const normalize = (p: string): string => {
    const parts: string[] = []
    for (const part of p.split('/')) {
      if (part === '..') parts.pop()
      else if (part && part !== '.') parts.push(part)
    }
    return `/${parts.join('/')}`
  }
  const root = normalize(cwd)
  const target = normalize(path.startsWith('/') ? path : `${root}/${path}`)
  return target !== root && !target.startsWith(root === '/' ? root : `${root}/`)
}

export function sessionScope(agent: AgentId, tool: string): string {
  if (tool.startsWith('mcp__cockpit__')) return 'Allow for this session remembers this kind of Cockpit action until this agent session ends.'
  if (agent === 'claude') return 'Claude manages this grant. It can allow other actions in the same folder, not just this exact request, for the rest of the session.'
  if (agent === 'codex') return /Shell|Bash/.test(tool)
    ? 'Codex remembers this exact command for this session; a different command may ask again.'
    : 'Codex manages the scope of this session grant. It may cover more than this one request.'
  return 'The agent manages this grant and may reuse it for similar actions during this session.'
}
