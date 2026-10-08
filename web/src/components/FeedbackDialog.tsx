import { useEffect, useRef, useState, type FormEvent } from 'react'
import { feedbackUrl, type FeedbackKind } from '../../../server/help-links.ts'
import { native } from '../native.ts'

// Report a bug / Send feedback, from the toolbar (as in Enjoy). Cockpit has no service of its own:
// this fills in a new GitHub issue and opens it in the browser, where the person reviews it, adds
// screenshots and submits it. The version and macOS go in only while "Include" is on.

interface FeedbackDialogProps {
  readonly onClose: () => void
}

export function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [includeInfo, setIncludeInfo] = useState(true)
  const [version, setVersion] = useState<string>()
  const [opened, setOpened] = useState(false)
  const titleBox = useRef<HTMLInputElement>(null)

  useEffect(() => titleBox.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => { void native?.appVersion().then(setVersion, () => undefined) }, [])

  const ready = title.trim().length > 0
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    if (native?.reportIssue) native.reportIssue({ kind, title, details, includeInfo })
    // Outside the desktop app there is no Mac to describe: the issue is opened without it.
    else window.open(feedbackUrl({ kind, title, details }), '_blank', 'noopener')
    setOpened(true)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title" onSubmit={submit}>
        <header className="modal-head">
          <h2 id="feedback-title">{kind === 'bug' ? 'Report a bug' : 'Send feedback'}</h2>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {opened ? (
          <>
            <p className="modal-note" role="status">
              The report is open in your browser on GitHub. Check it, add screenshots if they help, then press Create there. Nothing was sent from Cockpit.
            </p>
            <div className="picker-foot">
              <button type="button" className="button-primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="feedback-kind" role="radiogroup" aria-label="Kind">
              {(['bug', 'feedback'] as const).map((k) => (
                <label key={k} className={`feedback-kind-option${kind === k ? ' chosen' : ''}`}>
                  <input type="radio" name="feedback-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                  {k === 'bug' ? 'Something is wrong' : 'An idea or a comment'}
                </label>
              ))}
            </div>
            <div className="project-settings-body">
              <label className="field">
                Title
                <input ref={titleBox} aria-label="Title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder={kind === 'bug' ? 'For example: Stop does nothing while Codex is thinking' : 'For example: Let me rename a worktree'} />
              </label>
              <label className="field">
                Details
                <textarea aria-label="Details" rows={7} value={details} onChange={(e) => setDetails(e.target.value)}
                  placeholder={kind === 'bug' ? 'What happened, what you expected, and the steps that lead to it.' : 'What would make Cockpit better for you?'} />
              </label>
              {native?.reportIssue ? (
                <label className="field-check">
                  <input type="checkbox" checked={includeInfo} onChange={(e) => setIncludeInfo(e.target.checked)} />
                  <span>Include Cockpit {version ?? ''} and your macOS version. Nothing else: no file names, conversations or logs.</span>
                </label>
              ) : null}
              <p className="modal-note">
                This opens a <strong>public</strong> GitHub issue in your browser for you to check and submit (you need a GitHub account). Leave out passwords, keys and anything private.
              </p>
            </div>
            <div className="picker-foot">
              <button type="button" className="button-soft" onClick={onClose}>Cancel</button>
              <button type="submit" className="button-primary" disabled={!ready}>Continue on GitHub</button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
