import { useEffect, useState, type ReactNode } from 'react'
import { HELP } from '../../../server/help-links.ts'
import type { ReleaseNotes as Notes } from '../../../electron/updates.ts'
import { native } from '../native.ts'
import { notesBlocks, type Span } from '../notes-text.ts'

interface ReleaseNotesProps {
  /** Shown above the notes after an update, e.g. "Updated to Cockpit 0.1.5". */
  lead?: string
  onClose: () => void
}

const inline = (text: Span[]): ReactNode[] =>
  text.map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.bold ? <strong key={i}>{s.text}</strong> : <span key={i}>{s.text}</span>))

/** Help → Release Notes: what changed in the running version, read from the release feed. */
export function ReleaseNotes({ lead, onClose }: ReleaseNotesProps) {
  const [notes, setNotes] = useState<Notes>()

  useEffect(() => {
    let live = true
    const failed = (): Notes => ({ state: 'unavailable', reason: 'Cockpit could not load the release notes.' })
    ;(native ? native.releaseNotes() : Promise.resolve(failed())).then((n) => { if (live) setNotes(n) }, () => { if (live) setNotes(failed()) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const body = (): ReactNode => {
    if (!notes) return <p className="modal-note" role="status">Loading…</p>
    if (notes.state === 'missing') return <p className="modal-note">No notes were published for Cockpit {notes.version}.</p>
    if (notes.state === 'unavailable') return <p className="modal-error" role="alert">{notes.reason}</p>
    return notesBlocks(notes.markdown).map((block, i) => {
      if (block.kind === 'heading') return block.level === 1 ? <h3 key={i}>{inline(block.text)}</h3> : <h4 key={i}>{inline(block.text)}</h4>
      if (block.kind === 'list') return <ul key={i}>{block.items.map((item, j) => <li key={j}>{inline(item)}</li>)}</ul>
      return <p key={i}>{inline(block.text)}</p>
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal release-notes" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
        <header className="modal-head">
          <h2 id="release-notes-title">{lead ?? 'Release Notes'}</h2>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="release-notes-body">{body()}</div>
        <footer className="modal-foot">
          <a className="picker-browse" href={HELP.releases} target="_blank" rel="noreferrer">Every release on GitHub</a>
          <span className="modal-count" />
          <button type="button" className="button-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}
