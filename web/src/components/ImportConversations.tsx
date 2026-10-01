import { useEffect, useState } from 'react'
import { api, type ImportableSession, type Project, type ThreadMeta } from '../api.ts'
import { agentName } from '../transcript.ts'
import { AgentGlyph } from './AgentGlyph.tsx'

interface ImportProps {
  project: Project
  onImported: (meta: ThreadMeta) => void
  onClose: () => void
}

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** The project's existing Claude Code and Codex sessions, to continue in Cockpit. */
export function ImportConversations({ project, onImported, onClose }: ImportProps) {
  const [sessions, setSessions] = useState<ImportableSession[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  useEffect(() => {
    api.listImportable(project.path).then(setSessions, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [project.path])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const importOne = (s: ImportableSession): void => {
    setBusy(s.sessionId)
    setError(undefined)
    api.importSession(project.path, s.agent, s.sessionId).then(onImported, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(undefined)
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal import-sessions" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header className="modal-head">
          <h2 id="import-title">Import conversations</h2>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="modal-note">
          Sessions you ran in {project.name} with Claude Code or Codex outside Cockpit. Importing one copies its messages and steps
          into a conversation here; your next message continues the same session. The CLIs’ own files are only read.
        </p>
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        {!sessions ? <p role="status">Looking for sessions…</p> : sessions.length === 0 ? (
          <p className="modal-note">No Claude Code or Codex sessions found for this folder.</p>
        ) : (
          <ul className="import-list">
            {sessions.map((s) => (
              <li key={`${s.agent}:${s.sessionId}`} className="import-row">
                <AgentGlyph author={s.agent} />
                <span className="import-text">
                  <strong>{s.firstPrompt}</strong>
                  <small>{agentName(s.agent)} · {when(s.updatedAt)} · {s.messages} {s.messages === 1 ? 'message' : 'messages'}</small>
                </span>
                {s.inCockpit ? <span className="import-done">In Cockpit</span> : (
                  <button type="button" className="button-soft" disabled={Boolean(busy)} aria-label={`Import “${s.firstPrompt.slice(0, 40)}”`} onClick={() => importOne(s)}>
                    {busy === s.sessionId ? 'Importing…' : 'Import'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <footer className="modal-foot">
          <span className="modal-count">{sessions ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}` : ''}</span>
          <button type="button" className="button-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}
