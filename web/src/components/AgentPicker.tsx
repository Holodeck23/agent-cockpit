import { useEffect, useState } from 'react'
import { effortsFor, PERMISSION_MODES } from '../../../server/agents/claude/flags.ts'
import type { AgentId } from '../../../server/agents/types.ts'
import { api, type AgentStatus, type Preset, type ThreadSettings } from '../api.ts'
import { agentName } from '../transcript.ts'
import { loadMemory, permissionModesFor, recall, remember, saveMemory, type AgentMemory } from '../agent-memory.ts'
import { focusComposer } from '../focus-composer.ts'
import { permissionLabel } from '../permission-labels.ts'
import { usePopover } from '../usePopover.ts'
import { formatWhen, usageLine } from '../usage.ts'
import { AgentGlyph } from './AgentGlyph.tsx'
import { ChevronDownIcon } from './icons.tsx'

export interface AgentChoice {
  readonly agent: AgentId
  readonly model: string
  readonly effort: string
  readonly permissionMode: ThreadSettings['permissionMode']
  /** Use my Chrome (Claude only). */
  readonly chrome?: boolean
}

const MODEL_SUGGESTIONS: Record<AgentId, readonly string[]> = {
  claude: ['haiku', 'sonnet', 'opus'],
  // Account-specific model ids can be typed; blank uses the user's CLI default.
  codex: [],
  // Current subscription-backed models reported by `agy models`; blank uses Antigravity's default.
  antigravity: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
  // OpenRouter through OpenCode: openrouter/<provider>/<model>; blank uses OpenCode's own default.
  opencode: ['openrouter/anthropic/claude-sonnet-4', 'openrouter/openai/gpt-4o', 'openrouter/google/gemini-2.5-pro'],
}

export { PERMISSION_LABEL } from '../permission-labels.ts'

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export function choiceSummary(choice: AgentChoice): string {
  // Provider/model names (openrouter/…) are shown as typed; OpenCode has no effort setting of its own.
  const model = choice.model ? (choice.model.includes('/') ? choice.model : capitalize(choice.model)) : 'Default model'
  return choice.agent === 'opencode' ? model : `${model} · ${choice.effort ? capitalize(choice.effort) : 'Default effort'}`
}

export function settingsFromChoice(choice: AgentChoice, base?: ThreadSettings): Partial<ThreadSettings> {
  const { model: _model, effort: _effort, useChrome: _chrome, ...rest } = base ?? { useHooks: false }
  return {
    ...rest,
    ...(choice.agent === 'claude' && choice.chrome ? { useChrome: true } : {}),
    agent: choice.agent,
    permissionMode: choice.permissionMode,
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort as ThreadSettings['effort'] } : {}),
  }
}

/** Installed state and the provider's last usage report for the selected agent. */
function AgentState({ status, loading }: { status: AgentStatus | undefined; loading: boolean }) {
  if (!status) return <p className="agent-state-note">{loading ? 'Checking this agent…' : 'Status unavailable right now.'}</p>
  const { installation, usage } = status
  const percent = usage?.usedPercent
  return (
    <div className="agent-state" role="group" aria-label={`${agentName(status.id)} status`}>
      {installation.installed ? (
        <p className="agent-state-line">{installation.version !== undefined ? `Installed · ${installation.version}` : 'Installed · version not checked yet'}</p>
      ) : (
        <p className="agent-state-line agent-state-problem">{installation.problem}</p>
      )}
      {usage ? (
        <>
          <p className="agent-state-line">{usageLine(usage)}</p>
          {percent !== undefined ? (
            <div className="usage-bar" role="meter" aria-label={`${agentName(status.id)} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
            </div>
          ) : null}
          <p className="agent-state-note">Reported by {agentName(status.id)} as of {formatWhen(Date.parse(usage.observedAt))}.</p>
        </>
      ) : (
        <p className="agent-state-note">No usage reported yet; it appears after this agent's next turn.</p>
      )}
    </div>
  )
}

/** Use my Chrome (H4): Claude's own Chrome tools through the installed extension, not Cockpit's browser pane. */
function UseMyChrome({ checked, readiness, onChange }: { checked: boolean; readiness: AgentStatus['chrome']; onChange: (chrome: boolean) => void }) {
  const unsupported = readiness?.supported === false
  const state = !readiness ? 'Checking Claude Code and the Chrome extension…'
    : unsupported ? 'Not available: this Claude Code has no --chrome option. Update it first.'
    : readiness.extension ? 'Ready: the Claude extension’s helper is installed. Chrome is checked on first use.'
    : 'Not set up on this Mac: the Claude extension’s helper is missing. Install the extension in Chrome first.'
  return (
    <div className="use-chrome">
      <label className="check">
        <input type="checkbox" checked={checked} disabled={unsupported && !checked} onChange={(e) => onChange(e.target.checked)} />
        <span>Use my Chrome</span>
      </label>
      <p className="picker-note">
        Claude uses your own Chrome, with the sites you are signed in to, through the Claude extension.
        It is separate from Cockpit’s browser, and stopping never closes Chrome or its tabs.
        <br />{state}
      </p>
    </div>
  )
}

interface AgentPickerProps {
  value: AgentChoice
  /** New conversation: every change applies at once. */
  onChange?: (choice: AgentChoice) => void
  /** Existing conversation, another agent: applies on "Switch" (the transcript goes along). */
  onSwitch?: (choice: AgentChoice) => void
  /** Existing conversation, same agent: applies on "Apply"; the agent's session continues. */
  onApply?: (choice: AgentChoice) => void
  /** Why changing is unavailable right now, e.g. while a turn runs. */
  lockedReason?: string
}

const CLOSE_KEY = 'cockpit:picker-close-after'
const readCloseAfter = (): boolean => { try { return localStorage.getItem(CLOSE_KEY) === 'true' } catch { return false } }

/** One click to the agent's effort, beside the picker (OpenCode has no effort setting). */
function EffortButton({ value, disabled, onPick }: { value: AgentChoice; disabled?: string; onPick: (effort: string) => void }) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>({ onEscape: () => focusComposer(ref.current) })
  if (value.agent === 'opencode') return null
  const label = value.effort ? capitalize(value.effort) : 'Default'
  return (
    <div className="picker effort-picker" ref={ref}>
      <button type="button" className="effort-button" aria-label={`Effort: ${label}`} aria-expanded={open} title={disabled ?? 'Effort'} disabled={disabled !== undefined} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDownIcon className="chevron" />
      </button>
      {open ? (
        <div className="menu effort-menu" role="menu" aria-label="Effort">
          {['', ...effortsFor(value.agent, value.model)].map((effort) => (
            <button key={effort || 'default'} type="button" role="menuitemradio" aria-checked={value.effort === effort} className="menu-item"
              onClick={() => { onPick(effort); setOpen(false); focusComposer(ref.current) }}>
              {effort ? capitalize(effort) : 'Default'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AgentPicker({ value, onChange, onSwitch, onApply, lockedReason }: AgentPickerProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>({ onEscape: () => focusComposer(ref.current) })
  const existing = onSwitch !== undefined || onApply !== undefined
  const [draft, setDraft] = useState<AgentChoice>(value)
  const current = existing ? draft : value
  const changed = JSON.stringify(draft) !== JSON.stringify(value)
  const sameAgent = draft.agent === value.agent
  const [statuses, setStatuses] = useState<AgentStatus[] | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [memory, setMemory] = useState<AgentMemory>(loadMemory)
  const [closeAfter, setCloseAfter] = useState(readCloseAfter)
  const [presets, setPresets] = useState<Preset[]>([])
  const [naming, setNaming] = useState<string | undefined>(undefined)
  const [presetError, setPresetError] = useState('')

  // Checked each time the panel opens: cheap, and never polled in the background.
  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true)
    api.presets().then((rows) => { if (current) setPresets(rows) }, () => { if (current) setPresets([]) })
    api.agents()
      .then((next) => { if (current) setStatuses(next) })
      .catch(() => { if (current) setStatuses(undefined) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [open])

  const set = (next: AgentChoice): void => {
    const remembered = remember(memory, next)
    setMemory(remembered)
    saveMemory(remembered)
    if (existing) setDraft(next)
    else onChange?.(next)
  }
  const patch = (change: Partial<AgentChoice>): void => set({ ...current, ...change })
  const close = (): void => { setOpen(false); focusComposer(ref.current) }

  // Named settings: one click applies them (in a conversation, Apply/Switch still confirms).
  const savePresets = (next: Preset[]): void => {
    api.savePresets(next).then((saved) => { setPresets(saved); setPresetError(''); setNaming(undefined) },
      (e: unknown) => setPresetError(e instanceof Error ? e.message : String(e)))
  }
  const savePreset = (): void => savePresets([...presets, { name: (naming ?? '').trim(), ...current, effort: current.effort as Preset['effort'] }])
  const matches = (p: Preset): boolean => p.agent === current.agent && p.model === current.model && p.effort === current.effort && p.permissionMode === current.permissionMode

  const toggle = (): void => {
    if (!open) setDraft(value)
    setOpen(!open)
  }

  // Effort beside the picker applies at once: in a new conversation directly, in an existing one
  // as a same-agent settings change (the agent's session continues).
  const pickEffort = (effort: string): void => {
    const next = { ...value, effort }
    set(next)
    if (existing) onApply?.(next)
  }

  return (
    <div className="picker-group">
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
            <div className="presets" role="group" aria-label="Presets">
              {presets.map((preset) => (
                <span key={preset.name} className={`preset-chip${matches(preset) ? ' active' : ''}`}>
                  <button type="button" aria-pressed={matches(preset)} title={`${agentName(preset.agent)} · ${choiceSummary(preset)} · ${permissionLabel(preset.agent, preset.permissionMode)}`}
                    onClick={() => { set({ agent: preset.agent, model: preset.model, effort: preset.effort, permissionMode: preset.permissionMode }); if (closeAfter && !existing) close() }}>
                    {preset.name}
                  </button>
                  <button type="button" className="preset-remove" aria-label={`Remove preset ${preset.name}`} onClick={() => savePresets(presets.filter((p) => p !== preset))}>×</button>
                </span>
              ))}
              {naming === undefined ? (
                <button type="button" className="preset-add" onClick={() => { setNaming(''); setPresetError('') }}>{presets.length ? '+ Save as preset' : 'Save these settings as a preset'}</button>
              ) : (
                // Not a <form>: the panel sits inside the composer's form, and a nested form's Save
                // submitted the page natively (a reload) instead of saving.
                <div className="preset-form">
                  <input aria-label="Preset name" placeholder="Name, e.g. Quick fix" maxLength={40} value={naming} autoFocus onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (naming.trim()) savePreset() } }} />
                  <button type="button" className="button-soft" disabled={!naming.trim()} onClick={savePreset}>Save</button>
                </div>
              )}
              {presetError ? <p className="picker-note" role="alert">{presetError}</p> : null}
            </div>
            <div className="segmented" role="radiogroup" aria-label="Agent">
              {(['claude', 'codex', 'antigravity', 'opencode'] as const).map((agent) => (
                <button
                  key={agent}
                  type="button"
                  role="radio"
                  aria-checked={current.agent === agent}
                  onClick={() => {
                    // Switching back to an agent restores what it was last set to on this Mac.
                    set(agent === current.agent ? current : recall(memory, agent))
                    if (closeAfter && !existing) close()
                  }}
                >
                  <AgentGlyph author={agent} />
                  <span>{agentName(agent)}</span>
                  {statuses?.find((s) => s.id === agent)?.installation.installed === false ? <span className="agent-missing">Unavailable</span> : null}
                </button>
              ))}
            </div>
            <AgentState status={statuses?.find((s) => s.id === current.agent)} loading={loading} />
            <label className="field">
              Model
              <input
                list={`models-${current.agent}`}
                value={current.model}
                placeholder="Default model"
                onChange={(e) => patch({ model: e.target.value.trim() })}
              />
              <datalist id={`models-${current.agent}`}>
                {MODEL_SUGGESTIONS[current.agent].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            {current.agent === 'opencode' ? null : (
              <label className="field">
                Effort
                <select value={current.effort} onChange={(e) => patch({ effort: e.target.value })}>
                  <option value="">Default</option>
                  {effortsFor(current.agent, current.model).map((effort) => (
                    <option key={effort} value={effort}>
                      {capitalize(effort)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Permissions
              <select value={current.permissionMode} onChange={(e) => patch({ permissionMode: e.target.value as AgentChoice['permissionMode'] })}>
                {permissionModesFor(current.agent).map((mode) => (
                  <option key={mode} value={mode}>
                    {permissionLabel(current.agent, mode)}
                  </option>
                ))}
              </select>
            </label>
            {current.agent === 'claude' ? (
              <UseMyChrome checked={current.chrome === true} readiness={statuses?.find((s) => s.id === 'claude')?.chrome} onChange={(chrome) => patch({ chrome })} />
            ) : null}
            {current.agent === 'antigravity' ? (
              <p className="picker-note">
                {current.permissionMode === 'manual'
                  ? 'Follows your Antigravity settings. Antigravity cannot pause for approval: workspace edits proceed, commands that would need one are denied.'
                  : current.permissionMode === 'bypassPermissions'
                    ? 'Antigravity cannot pause for approval, so it runs without asking. Use Plan for read-only work.'
                    : 'Read-only: Antigravity plans and makes no changes.'}
              </p>
            ) : null}
            {existing ? (
              <div className="picker-foot">
                <span className="picker-note">{lockedReason ?? (sameAgent ? 'Applies from your next message; the session continues.' : 'The conversation so far goes to the new agent.')}</span>
                <button
                  type="button"
                  className="button-primary"
                  disabled={!changed || lockedReason !== undefined}
                  onClick={() => {
                    if (sameAgent) onApply?.(draft)
                    else onSwitch?.(draft)
                    close()
                  }}
                >
                  {sameAgent ? 'Apply' : 'Switch'}
                </button>
              </div>
            ) : (
              <label className="check picker-close-after">
                <input type="checkbox" checked={closeAfter} onChange={(e) => {
                  setCloseAfter(e.target.checked)
                  try { localStorage.setItem(CLOSE_KEY, String(e.target.checked)) } catch { /* preference only */ }
                }} />
                <span>Close after choosing an agent</span>
              </label>
            )}
          </div>
        ) : null}
      </div>
      <EffortButton value={value} disabled={existing ? lockedReason : undefined} onPick={pickEffort} />
    </div>
  )
}
