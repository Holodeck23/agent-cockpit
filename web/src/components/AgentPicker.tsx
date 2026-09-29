import { useState } from 'react'
import { EFFORTS, PERMISSION_MODES } from '../../../server/agents/claude/flags.ts'
import type { AgentId } from '../../../server/agents/types.ts'
import type { ThreadSettings } from '../api.ts'
import { agentName } from '../transcript.ts'
import { usePopover } from '../usePopover.ts'
import { AgentGlyph } from './AgentGlyph.tsx'
import { ChevronDownIcon } from './icons.tsx'

export interface AgentChoice {
  readonly agent: AgentId
  readonly model: string
  readonly effort: string
  readonly permissionMode: ThreadSettings['permissionMode']
}

const MODEL_SUGGESTIONS: Record<AgentId, readonly string[]> = {
  claude: ['haiku', 'sonnet', 'opus'],
  // Account-specific model ids can be typed; blank uses the user's CLI default.
  codex: [],
}

const PERMISSION_LABEL: Record<ThreadSettings['permissionMode'], string> = {
  manual: 'Ask before acting',
  acceptEdits: 'Edit files without asking',
  plan: 'Plan only, no changes',
  auto: 'Auto',
  dontAsk: 'Never ask',
  bypassPermissions: 'Bypass all permissions',
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export function choiceSummary(choice: AgentChoice): string {
  return `${choice.model ? capitalize(choice.model) : 'Default model'} · ${choice.effort ? capitalize(choice.effort) : 'Default effort'}`
}

export function settingsFromChoice(choice: AgentChoice, base?: ThreadSettings): Partial<ThreadSettings> {
  const { model: _model, effort: _effort, ...rest } = base ?? { useHooks: false }
  return {
    ...rest,
    agent: choice.agent,
    permissionMode: choice.permissionMode,
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort as ThreadSettings['effort'] } : {}),
  }
}

interface AgentPickerProps {
  value: AgentChoice
  /** New conversation: every change applies at once. */
  onChange?: (choice: AgentChoice) => void
  /** Existing conversation: changes apply when "Switch" is pressed (the transcript goes along). */
  onSwitch?: (choice: AgentChoice) => void
  /** Why switching is unavailable right now, e.g. while a turn runs. */
  lockedReason?: string
}

export function AgentPicker({ value, onChange, onSwitch, lockedReason }: AgentPickerProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [draft, setDraft] = useState<AgentChoice>(value)
  const current = onSwitch ? draft : value
  const changed = JSON.stringify(draft) !== JSON.stringify(value)

  const set = (patch: Partial<AgentChoice>): void => {
    const next = { ...current, ...patch }
    if (onSwitch) setDraft(next)
    else onChange?.(next)
  }

  const toggle = (): void => {
    if (!open) setDraft(value)
    setOpen(!open)
  }

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="picker-button" aria-label="Agent settings" aria-expanded={open} onClick={toggle}>
        <AgentGlyph author={value.agent} />
        <span className="picker-text">
          <span className="picker-name">{agentName(value.agent)}</span>
          <span className="picker-sub">{choiceSummary(value)}</span>
        </span>
        <ChevronDownIcon className="chevron" />
      </button>
      {open ? (
        <div className="picker-panel" role="dialog" aria-label="Agent settings">
          <div className="segmented" role="radiogroup" aria-label="Agent">
            {(['claude', 'codex'] as const).map((agent) => (
              <button
                key={agent}
                type="button"
                role="radio"
                aria-checked={current.agent === agent}
                onClick={() => set({ agent, model: agent === current.agent ? current.model : '' })}
              >
                <AgentGlyph author={agent} />
                {agentName(agent)}
              </button>
            ))}
          </div>
          <label className="field">
            Model
            <input
              list={`models-${current.agent}`}
              value={current.model}
              placeholder="Default model"
              onChange={(e) => set({ model: e.target.value.trim() })}
            />
            <datalist id={`models-${current.agent}`}>
              {MODEL_SUGGESTIONS[current.agent].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="field">
            Effort
            <select value={current.effort} onChange={(e) => set({ effort: e.target.value })}>
              <option value="">Default</option>
              {EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {capitalize(effort)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Permissions
            <select value={current.permissionMode} onChange={(e) => set({ permissionMode: e.target.value as AgentChoice['permissionMode'] })}>
              {PERMISSION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_LABEL[mode]}
                </option>
              ))}
            </select>
          </label>
          {onSwitch ? (
            <div className="picker-foot">
              <span className="picker-note">{lockedReason ?? 'The conversation so far goes to the new agent.'}</span>
              <button
                type="button"
                className="button-primary"
                disabled={!changed || lockedReason !== undefined}
                onClick={() => {
                  onSwitch(draft)
                  setOpen(false)
                }}
              >
                Switch
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
