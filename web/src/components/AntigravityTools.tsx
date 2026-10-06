import { useState } from 'react'
import { api, type Project } from '../api.ts'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * P3: Antigravity gets Cockpit's tools in this project only when turned on here. It applies at once
 * (it writes a plugin into the folder), unlike the fields that wait for Save.
 */
export function AntigravityTools({ project }: { project: Project }) {
  const [connected, setConnected] = useState(project.antigravityMcp !== undefined)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const change = (next: boolean): void => {
    setBusy(true)
    setError('')
    setNote('')
    api.setAntigravityTools(project.path, next).then((result) => {
      setConnected(result.project.antigravityMcp !== undefined)
      setNote(result.message ?? (result.backup ? `Cockpit's earlier entry was replaced; the previous file is kept at ${result.backup}.` : ''))
    }, (e: unknown) => setError(message(e))).finally(() => setBusy(false))
  }
  return (
    <div className="field-check-group">
      <label className="field-check">
        <input type="checkbox" checked={connected} disabled={busy} onChange={(e) => change(e.target.checked)} />
        <span>
          <strong>Give Antigravity Cockpit&apos;s tools</strong>
          Antigravity can then start and watch processes, open previews and use the other Cockpit tools here, like the other
          agents. Cockpit adds its own plugin in <code>.agents/plugins/cockpit</code>, which Git ignores; the session&apos;s access
          key is never written to it. Turning it off removes the plugin. Applies when Antigravity next starts.
        </span>
      </label>
      {note ? <p className="modal-note">{note}</p> : null}
      {error ? <p className="modal-error" role="alert">{error}</p> : null}
    </div>
  )
}
