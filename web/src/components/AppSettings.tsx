import { useEffect } from 'react'
import { playSound, type SoundKind, type SoundSettings } from '../sounds.ts'

interface AppSettingsProps {
  sounds: SoundSettings
  onSounds: (next: SoundSettings) => void
  onClose: () => void
}

const SOUNDS: ReadonlyArray<{ id: SoundKind; label: string; detail: string }> = [
  { id: 'reply', label: 'When an agent replies', detail: 'A soft two-note chime when a turn finishes.' },
  { id: 'decision', label: 'When an agent needs a decision', detail: 'A brighter three-note call when an approval is waiting.' },
]

/** App-wide settings. Appearance stays in its own top-bar popover; project settings live with the project. */
export function AppSettings({ sounds, onSounds, onClose }: AppSettingsProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal app-settings" role="dialog" aria-modal="true" aria-labelledby="app-settings-title">
        <header className="modal-head">
          <h2 id="app-settings-title">Settings</h2>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <section className="settings-section" aria-labelledby="settings-sounds">
          <h3 id="settings-sounds">Sounds</h3>
          {SOUNDS.map((s) => (
            <div key={s.id} className="settings-row">
              <label className="check">
                <input type="checkbox" checked={sounds[s.id]} onChange={(e) => onSounds({ ...sounds, [s.id]: e.target.checked })} />
                <span><strong>{s.label}</strong><small>{s.detail}</small></span>
              </label>
              <button type="button" className="button-soft" aria-label={`Play the ${s.id} sound`} onClick={() => playSound(s.id)}>Play</button>
            </div>
          ))}
          <p className="modal-note">Sounds play while Cockpit is open, from any project. They are off until you turn them on, and remembered on this Mac.</p>
        </section>
        <section className="settings-section" aria-labelledby="settings-elsewhere">
          <h3 id="settings-elsewhere">Elsewhere</h3>
          <p className="modal-note">Theme and density are under Appearance in the top bar. Phone access has its own button there, and each project’s name, instructions and folder are in its project settings.</p>
        </section>
        <footer className="modal-foot">
          <span className="modal-count" />
          <button type="button" className="button-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}
