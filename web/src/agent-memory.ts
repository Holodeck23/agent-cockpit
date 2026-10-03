// What each agent was last set to on this Mac (model, effort, permissions), so switching back to
// an agent restores it instead of starting over. Kept per device in localStorage.
import { PERMISSION_MODES } from '../../server/agents/claude/flags.ts'
import type { AgentId } from '../../server/agents/types.ts'
import type { AgentChoice } from './components/AgentPicker.tsx'

type Mode = AgentChoice['permissionMode']
type Saved = Pick<AgentChoice, 'model' | 'effort' | 'permissionMode'>
export type AgentMemory = Partial<Record<AgentId, Saved>>

const AGENTS: readonly AgentId[] = ['claude', 'codex', 'antigravity', 'opencode']
const KEY = 'cockpit:agent-choices'

/**
 * Antigravity headless cannot pause for approval, so its only modes are skipping permissions,
 * its own configured policy (`manual`: Cockpit passes no permission flag) and plan mode.
 */
export function permissionModesFor(agent: AgentId): readonly Mode[] {
  return agent === 'antigravity' ? ['bypassPermissions', 'manual', 'plan'] : PERMISSION_MODES
}

export function defaultPermission(agent: AgentId): Mode {
  return agent === 'antigravity' ? 'bypassPermissions' : 'manual'
}

export function remember(memory: AgentMemory, choice: AgentChoice): AgentMemory {
  return { ...memory, [choice.agent]: { model: choice.model, effort: choice.effort, permissionMode: choice.permissionMode } }
}

export function recall(memory: AgentMemory, agent: AgentId): AgentChoice {
  const saved = memory[agent]
  const mode = saved && permissionModesFor(agent).includes(saved.permissionMode) ? saved.permissionMode : defaultPermission(agent)
  return { agent, model: saved?.model ?? '', effort: saved?.effort ?? '', permissionMode: mode }
}

export function parseMemory(raw: string | null): AgentMemory {
  try {
    const stored: unknown = raw ? JSON.parse(raw) : {}
    if (!stored || typeof stored !== 'object') return {}
    const memory: AgentMemory = {}
    for (const agent of AGENTS) {
      const s = (stored as Record<string, unknown>)[agent] as Record<string, unknown> | undefined
      if (s && typeof s.model === 'string' && typeof s.effort === 'string' && PERMISSION_MODES.includes(s.permissionMode as Mode)) {
        memory[agent] = { model: s.model, effort: s.effort, permissionMode: s.permissionMode as Mode }
      }
    }
    return memory
  } catch {
    return {}
  }
}

export function loadMemory(): AgentMemory {
  try { return parseMemory(localStorage.getItem(KEY)) } catch { return {} }
}

export function saveMemory(memory: AgentMemory): void {
  try { localStorage.setItem(KEY, JSON.stringify(memory)) } catch { /* convenience only */ }
}
