import type { Appearance, Density, RowShows } from '../appearance.ts'
import type { ThemeMode } from '../theme.ts'
import { usePopover } from '../usePopover.ts'
import { ContrastIcon, MonitorIcon, MoonIcon, SunIcon } from './icons.tsx'
import { flippedTheme, shownTheme } from '../theme-toggle.ts'

interface AppearanceMenuProps {
  theme: ThemeMode
  onTheme: (mode: ThemeMode) => void
  appearance: Appearance
  onChange: (patch: Partial<Appearance>) => void
}

const THEMES: ReadonlyArray<{ id: ThemeMode; label: string }> = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]
const DENSITIES: ReadonlyArray<{ id: Density; label: string }> = [{ id: 'normal', label: 'Normal' }, { id: 'compact', label: 'Compact' }]
const ROW_PARTS: ReadonlyArray<{ id: keyof RowShows; label: string }> = [{ id: 'preview', label: 'Message preview' }, { id: 'agent', label: 'Agent' }, { id: 'date', label: 'Date' }]

function Choice<T extends string>({ label, options, value, onPick }: {
  label: string; options: ReadonlyArray<{ id: T; label: string }>; value: T; onPick: (id: T) => void
}) {
  return (
    <div className="appearance-row">
      <span aria-hidden>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onPick(o.id)}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

/** The top-bar Appearance popover: theme, density, and what conversation rows show. */
export function AppearanceMenu({ theme, onTheme, appearance, onChange }: AppearanceMenuProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const systemDark = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  // One click flips light and dark (D10); System, density and rows stay in the popover.
  const shown = shownTheme(theme, systemDark())
  return (
    <div className="appearance" ref={ref}>
      <button type="button" className="icon-button theme-toggle" aria-label={shown === 'dark' ? 'Switch to light' : 'Switch to dark'}
        title={shown === 'dark' ? 'Switch to light' : 'Switch to dark'} onClick={() => onTheme(flippedTheme(theme, systemDark()))}>
        {shown === 'dark' ? <MoonIcon /> : <SunIcon />}
      </button>
      <button type="button" className="icon-button" aria-label="Appearance" title="Appearance" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ContrastIcon />
      </button>
      {open ? (
        <div className="appearance-panel" role="dialog" aria-label="Appearance">
          <Choice label="Theme" options={THEMES} value={theme} onPick={onTheme} />
          <Choice label="Conversation list" options={DENSITIES} value={appearance.list} onPick={(list) => onChange({ list })} />
          <Choice label="Messages" options={DENSITIES} value={appearance.messages} onPick={(messages) => onChange({ messages })} />
          <fieldset className="appearance-row">
            <legend>List rows show</legend>
            {ROW_PARTS.map((part) => (
              <label key={part.id} className="check">
                <input type="checkbox" checked={appearance.rows[part.id]}
                  onChange={(e) => onChange({ rows: { ...appearance.rows, [part.id]: e.target.checked } })} />
                {part.label}
              </label>
            ))}
          </fieldset>
          <p className="appearance-note">Remembered on this device.</p>
        </div>
      ) : null}
    </div>
  )
}
