import { useEffect, useState } from 'react'
import type { NotifySettings } from '../mac-notifications.ts'
import { native } from '../native.ts'
import { REPORTS_WHAT } from '../reports-copy.ts'
import { playSound, type SoundKind, type SoundSettings } from '../sounds.ts'

interface AppSettingsProps {
  sounds: SoundSettings
  onSounds: (next: SoundSettings) => void
  notify: NotifySettings
  onNotify: (next: NotifySettings) => void
  onClose: () => void
}

const NOTIFY: ReadonlyArray<{ id: SoundKind; label: string }> = [
  { id: 'reply', label: 'When an agent finishes a turn' },
  { id: 'decision', label: 'When an agent needs an approval or has a question' },
]

const SOUNDS: ReadonlyArray<{ id: SoundKind; label: string; detail: string }> = [
  { id: 'reply', label: 'When an agent replies', detail: 'A soft two-note chime when a turn finishes.' },
  { id: 'decision', label: 'When an agent needs a decision', detail: 'A brighter three-note call when an approval is waiting.' },
]

/** App-wide settings. Appearance stays in its own top-bar popover; project settings live with the project. */
export function AppSettings({ sounds, onSounds, notify, onNotify, onClose }: AppSettingsProps) {
  // Crash and error reports: shown only in a build that sends them.
  const [reports, setReports] = useState<boolean | undefined>(undefined)
  const [savingReports, setSavingReports] = useState(false)
  const [reportsError, setReportsError] = useState<string>()
  useEffect(() => {
    void native?.reports?.().then((status) => { if (status?.available) setReports(status.reports) }, () => undefined)
  }, [])
  const answerReports = (on: boolean): void => {
    setSavingReports(true)
    setReportsError(undefined)
    void native?.reports?.(on).then((status) => {
      if (!status?.available || status.reports !== on) throw new Error('Choice was not accepted')
      setReports(status.reports)
    }).catch(() => setReportsError('Could not change crash reporting. Please try again.'))
      .finally(() => setSavingReports(false))
  }
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
        {native ? (
          <section className="settings-section" aria-labelledby="settings-notify">
            <h3 id="settings-notify">Mac notifications</h3>
            {NOTIFY.map((n) => (
              <div key={n.id} className="settings-row">
                <label className="check">
                  <input type="checkbox" checked={notify[n.id]} onChange={(e) => onNotify({ ...notify, [n.id]: e.target.checked })} />
                  <span><strong>{n.label}</strong></span>
                </label>
              </div>
            ))}
            <p className="modal-note">Never for the conversation you are looking at. Click one to open that conversation. macOS asks once whether Cockpit may notify; you can change that later in System Settings → Notifications.</p>
          </section>
        ) : null}
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
          <p className="modal-note">Sounds play while Cockpit is open, from any project, but not for the conversation you are looking at. They are off until you turn them on, and remembered on this Mac.</p>
        </section>
        {reports !== undefined ? (
          <section className="settings-section" aria-labelledby="settings-reports">
            <h3 id="settings-reports">Crash and error reports</h3>
            <div className="settings-row">
              <label className="check">
                <input type="checkbox" checked={reports} disabled={savingReports} onChange={(e) => answerReports(e.target.checked)} />
                <span><strong>Send crash and error reports to Cockpit's developer</strong><small>{REPORTS_WHAT}</small></span>
              </label>
            </div>
            {reportsError ? <p className="modal-note" role="alert">{reportsError}</p> : null}
          </section>
        ) : null}
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
