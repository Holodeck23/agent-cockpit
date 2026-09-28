import { useState } from 'react'
import type { AgentId } from '../../../server/agents/types.ts'
import { api, type ThreadMeta } from '../api.ts'

interface AgentSwitcherProps {
  meta: ThreadMeta
  disabled: boolean
  onError: (message: string) => void
}

const AGENTS: AgentId[] = ['claude', 'codex']

/** Hand the thread to another agent or model; the transcript travels with it. */
export function AgentSwitcher({ meta, disabled, onError }: AgentSwitcherProps) {
  const [agent, setAgent] = useState<AgentId>(meta.settings.agent)
  const [model, setModel] = useState(meta.settings.model ?? '')
  const changed = agent !== meta.settings.agent || model !== (meta.settings.model ?? '')

  const apply = (): void => {
    const { model: _previous, ...rest } = meta.settings
    api
      .switchAgent(meta.id, { ...rest, agent, ...(model ? { model } : {}) })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="switcher">
      <select aria-label="Agent" value={agent} disabled={disabled} onChange={(e) => setAgent(e.target.value as AgentId)}>
        {AGENTS.map((a) => (
          <option key={a}>{a}</option>
        ))}
      </select>
      <input
        aria-label="Switch model"
        value={model}
        placeholder="default model"
        disabled={disabled}
        onChange={(e) => setModel(e.target.value)}
      />
      <button type="button" disabled={disabled || !changed} onClick={apply}>
        Switch
      </button>
    </div>
  )
}
