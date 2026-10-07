import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Preflight } from '../api.ts'
import { branchSuggestion } from '../workspaces.ts'

// New worktree (W12.2 M1): a name, where it starts, and its branch. Before Create it says what a
// worktree does not contain: the main checkout's uncommitted files stay where they are.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const short = (hash: string): string => hash.slice(0, 7)

export function NewWorktreeDialog({ projectId, projectName, onCreate, onClose }: {
  projectId: string
  projectName: string
  /** Creates and selects the worktree; rejects with the server's refusal in words. */
  onCreate: (body: { name: string; base?: string; branch?: string }) => Promise<unknown>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [branch, setBranch] = useState('')
  const [preflight, setPreflight] = useState<Preflight>()
  const [blocked, setBlocked] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const nameBox = useRef<HTMLInputElement>(null)

  useEffect(() => nameBox.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])
  useEffect(() => {
    let live = true
    api.workspacePreflight(projectId).then((answer) => { if (live) setPreflight(answer) }, (e: unknown) => { if (live) setBlocked(message(e)) })
    return () => { live = false }
  }, [projectId])

  const prefix = preflight?.branchPrefix ?? 'codex/'
  const suggestion = branchSuggestion(prefix, name)
  const ready = name.trim().length > 0 && !blocked && !busy

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError('')
    onCreate({ name: name.trim(), ...(base.trim() ? { base: base.trim() } : {}), ...(branch.trim() ? { branch: branch.trim() } : {}) })
      .then(onClose, (e: unknown) => { setError(message(e)); setBusy(false) })
  }

  const uncommitted = preflight?.uncommitted ?? 0
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <form className="modal new-worktree" role="dialog" aria-modal="true" aria-labelledby="new-worktree-title" onSubmit={submit}>
        <header className="modal-head">
          <h2 id="new-worktree-title">New worktree</h2>
          <button type="button" className="activity-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
        </header>
        <p className="modal-note">A separate checkout of {projectName} on its own branch, so a conversation can work there without touching the main checkout.</p>
        <fieldset className="project-settings-body" disabled={busy}>
          <label className="field">
            Name
            <input ref={nameBox} aria-label="Worktree name" maxLength={60} placeholder="For example: Checkout redesign" value={name} onChange={(e) => { setName(e.target.value); setError('') }} />
          </label>
          <label className="field">
            Base
            <input aria-label="Base" placeholder={preflight ? `Main checkout HEAD (${short(preflight.head)}${preflight.branch ? `, ${preflight.branch}` : ''})` : 'Main checkout HEAD'}
              value={base} onChange={(e) => { setBase(e.target.value); setError('') }} />
            <small>Leave empty to start from the main checkout&apos;s current commit{preflight ? ` (${short(preflight.head)})` : ''}. A branch, tag or commit also works.</small>
          </label>
          <label className="field">
            Branch
            <input aria-label="Branch" placeholder={suggestion} value={branch} onChange={(e) => { setBranch(e.target.value); setError('') }} />
            <small>A new branch is created for it. Leave empty for {suggestion}.</small>
          </label>
        </fieldset>
        {blocked ? <p className="modal-error" role="alert">{blocked}</p> : (
          <p className="worktree-uncommitted" role="status">
            {preflight
              ? uncommitted > 0
                ? <><strong>{uncommitted} uncommitted file{uncommitted === 1 ? '' : 's'}</strong> in the main checkout will not be copied.</>
                : 'The main checkout has no uncommitted files. Anything uncommitted there later is not copied either.'
              : 'Checking the main checkout…'}
          </p>
        )}
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        <footer className="modal-foot">
          <span className="modal-count" />
          <button type="button" className="button-soft" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="button-primary" disabled={!ready}>{busy ? 'Creating…' : 'Create'}</button>
        </footer>
      </form>
    </div>
  )
}
