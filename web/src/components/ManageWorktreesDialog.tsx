import { useEffect, useState } from 'react'
import { api, type Project, type RemovalCheck, type ThreadSummary, type Workspace } from '../api.ts'
import type { Workspaces } from '../useWorkspaces.ts'
import { healthLabel, threadsIn, uniqueWork, worktreeLabel } from '../workspaces.ts'
import { MergeBack } from './MergeBack.tsx'

// Manage worktrees (W12.4): each worktree with its folder, branch, conversations and what Git says
// about it. Remove only after a fresh check finds nothing unique (Git removes it; its branch is
// kept); anything else can be kept or archived exactly as it is. A worktree whose folder is gone
// can be forgotten; Git's own records are left alone. Nothing here deletes files itself.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function Row({ worktree, project, workspaces, threads, onShowFiles }: {
  worktree: Workspace; project: Project; workspaces: Workspaces; threads: readonly ThreadSummary[]; onShowFiles?: () => void
}) {
  const [check, setCheck] = useState<RemovalCheck>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const health = workspaces.health[worktree.id]
  const label = healthLabel(health)
  const conversations = threadsIn(threads, worktree.id, project.workspaceId).length
  const archived = worktree.lifecycle === 'archived'

  const act = (work: () => Promise<unknown>): void => {
    setBusy(true)
    setNote('')
    work().then(() => setCheck(undefined), (e: unknown) => setNote(message(e))).finally(() => setBusy(false))
  }
  const lose = check ? uniqueWork(check) : undefined

  return (
    <li className="worktree-manage-row" aria-label={worktreeLabel(worktree)}>
      <div className="worktree-manage-head">
        <strong>{worktreeLabel(worktree)}</strong>
        {worktree.branch ? <code>{worktree.branch}</code> : null}
        {archived ? <span className="worktree-state">Archived</span> : null}
        {label ? <span className="worktree-state warn" title={health && 'detail' in health ? health.detail : undefined}>{label}</span> : null}
      </div>
      <small className="worktree-manage-path">{worktree.cwd}</small>
      <small>{conversations} conversation{conversations === 1 ? '' : 's'} ran here{health && 'detail' in health ? `. ${health.detail}` : '.'}</small>
      {check ? (
        <div className="worktree-check" role="status">
          {check.blockers.length ? <p>Not now: {check.blockers.join(' ')}</p>
            : lose ? <p>Removing it would lose {lose}. Keep it, or archive it as it is.</p>
              : <p>Nothing here is only in this worktree. Git removes the folder; the branch {check.branch ?? ''} is kept.</p>}
        </div>
      ) : null}
      {note ? <p className="modal-error" role="alert">{note}</p> : null}
      <div className="worktree-manage-actions">
        {archived ? (
          <button type="button" className="button-soft" disabled={busy} onClick={() => act(() => workspaces.change(worktree.id, 'restore'))}>Restore</button>
        ) : health?.state === 'missing' ? (
          <button type="button" className="button-soft" disabled={busy} title="Stop offering it. Git's own records are left as they are."
            onClick={() => act(() => workspaces.change(worktree.id, 'forget'))}>Forget</button>
        ) : (
          <>
            {check?.removable ? (
              <button type="button" className="button-danger" disabled={busy} onClick={() => act(() => workspaces.change(worktree.id, { remove: check.fingerprint }))}>Remove with Git</button>
            ) : (
              <button type="button" className="button-soft" disabled={busy} onClick={() => { setBusy(true); setNote(''); api.workspaceRemoval(worktree.id).then(setCheck, (e: unknown) => setNote(message(e))).finally(() => setBusy(false)) }}>
                Remove…
              </button>
            )}
            <button type="button" className="button-soft" disabled={busy} title="Take it out of use; its folder, branch and files stay exactly as they are."
              onClick={() => act(() => workspaces.change(worktree.id, 'archive'))}>Archive</button>
          </>
        )}
      </div>
      {!archived && health?.state !== 'missing' ? <MergeBack workspaceId={worktree.id} {...(onShowFiles ? { onShowFiles } : {})} onDone={() => void workspaces.refresh()} /> : null}
    </li>
  )
}

export function ManageWorktreesDialog({ project, workspaces, threads, onClose, onShowFiles }: {
  project: Project; workspaces: Workspaces; threads: readonly ThreadSummary[]; onClose: () => void
  /** Shows the main checkout's Files (to resolve a merge conflict). */
  onShowFiles?: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // What Git says is read again when the dialog opens.
  const { refresh } = workspaces
  useEffect(() => { void refresh() }, [refresh])
  const shown = [...workspaces.worktrees, ...workspaces.archived]
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="modal manage-worktrees" role="dialog" aria-modal="true" aria-labelledby="manage-worktrees-title">
        <header className="modal-head">
          <h2 id="manage-worktrees-title">Worktrees of {project.name}</h2>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="modal-note">Removing never deletes work: a worktree with changes, untracked or ignored files, or commits on no other branch is kept or archived as it is.</p>
        {shown.length ? (
          <ul className="worktree-manage-list">
            {shown.map((w) => <Row key={w.id} worktree={w} project={project} workspaces={workspaces} threads={threads} {...(onShowFiles ? { onShowFiles: () => { onClose(); onShowFiles() } } : {})} />)}
          </ul>
        ) : <p className="modal-note">This project has no worktrees.</p>}
      </section>
    </div>
  )
}
