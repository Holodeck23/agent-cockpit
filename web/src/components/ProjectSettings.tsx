import { useEffect, useRef, useState } from 'react'
import type { Project } from '../api.ts'

// Per-project instructions, added to every agent session started in that folder.
// The limit matches the server's (MAX_INSTRUCTIONS_CHARS in server/projects/store.ts).
const MAX_CHARS = 8000

interface ProjectSettingsProps {
  project: Project
  onSave: (instructions: string) => Promise<unknown>
  onClose: () => void
}

export function ProjectSettings({ project, onSave, onClose }: ProjectSettingsProps) {
  const [text, setText] = useState(project.instructions ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const changed = text.trim() !== (project.instructions ?? '')

  useEffect(() => box.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = (): void => {
    setSaving(true)
    setError(undefined)
    onSave(text)
      .then(() => setSaved(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false))
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
        <header className="modal-head">
          <h2 id="project-settings-title">{project.name}</h2>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="modal-path" title={project.path}>{project.path}</p>
        <label className="field modal-field">
          Project instructions
          <textarea
            ref={box}
            value={text}
            maxLength={MAX_CHARS}
            rows={10}
            placeholder="For example: Use pnpm, not npm. Run the tests before saying a change is done."
            onChange={(e) => { setText(e.target.value); setSaved(false) }}
          />
        </label>
        <p className="modal-note">
          Added to every agent session in this folder, alongside the repository&apos;s own instruction files, which Cockpit
          never edits. They apply when an agent next starts: a new conversation, a switch, or a conversation resuming.
          They never change permissions.
        </p>
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        <footer className="modal-foot">
          <span className="modal-count">
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
            {project.instructionsRevision ? ` · revision ${project.instructionsRevision}` : ''}
            {saved && !changed ? ' · saved' : ''}
          </span>
          <button type="button" className="button-soft" onClick={onClose}>Done</button>
          <button type="button" className="button-primary" disabled={!changed || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}
