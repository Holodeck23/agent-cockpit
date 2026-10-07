import { useState } from 'react'
import { api, type MergeOperationView, type MergePreflight } from '../api.ts'

// Merge back (W12.3), inside Manage worktrees: what would merge into what, then Git's own merge of
// exactly that. A conflict stays on screen with its paths until you Continue or Abort; nothing is
// pushed, and the worktree and its branch stay.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const short = (hash: string): string => hash.slice(0, 7)
const MODE = { 'fast-forward': 'Fast-forward: the main checkout moves to the worktree\'s commit.', merge: 'A merge commit joins both histories.', 'up-to-date': 'Nothing to merge: the main checkout already has it all.' } as const

export function MergeBack({ workspaceId, onShowFiles, onDone }: { workspaceId: string; onShowFiles?: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<MergePreflight>()
  const [operation, setOperation] = useState<MergeOperationView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const act = (work: () => Promise<void>): void => {
    setBusy(true)
    setError('')
    work().catch((e: unknown) => setError(message(e))).finally(() => setBusy(false))
  }
  const check = (): void => act(async () => {
    const next = await api.mergePreview(workspaceId)
    setPreview(next)
    setOperation(next.open)
  })
  const finished = (op: MergeOperationView): void => { setOperation(op); if (op.stage === 'merged' || op.stage === 'aborted') onDone() }

  if (!preview) return <button type="button" className="button-soft" disabled={busy} onClick={check}>Merge into the main checkout…</button>
  const target = preview.targetBranch ?? 'the main checkout'
  return (
    <div className="merge-back" role="group" aria-label="Merge back">
      {operation?.stage === 'conflict' ? (
        <>
          <p className="merge-conflict">The merge stopped on conflicts in {operation.conflicts.length} file{operation.conflicts.length === 1 ? '' : 's'}. Nothing is committed yet; the worktree is unchanged.</p>
          <ul className="merge-files">{operation.conflicts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          <p className="merge-note">Resolve them in the main checkout, stage them, then Continue. Abort puts the main checkout back where it was.</p>
          <div className="worktree-manage-actions">
            {onShowFiles ? <button type="button" className="button-soft" onClick={onShowFiles}>Show in Files</button> : null}
            <button type="button" className="button-primary" disabled={busy} onClick={() => act(async () => finished((await api.continueMerge(operation.id)).operation))}>Continue</button>
            <button type="button" className="button-soft" disabled={busy} onClick={() => act(async () => finished((await api.abortMerge(operation.id)).operation))}>Abort merge</button>
          </div>
        </>
      ) : operation?.stage === 'merged' ? (
        <p className="merge-note">Merged into {operation.targetBranch ?? 'the main checkout'}{operation.resultHead ? ` at ${short(operation.resultHead)}` : ''}. The worktree and its branch are kept; nothing was pushed.</p>
      ) : operation?.stage === 'aborted' ? (
        <p className="merge-note">Merge aborted: the main checkout is back at {short(operation.targetHeadBefore)}.</p>
      ) : (
        <>
          <p className="merge-note">
            {preview.sourceBranch ?? 'This worktree'} into <strong>{target}</strong> (main checkout): {preview.commits} commit{preview.commits === 1 ? '' : 's'}, {preview.files.length} file{preview.files.length === 1 ? '' : 's'}. {MODE[preview.mode]}
          </p>
          {preview.createdFromBranch ? <p className="merge-note">The worktree was created from {preview.createdFromBranch}; the main checkout is on {target} now, so that is where it would merge.</p> : null}
          {preview.files.length ? (
            <ul className="merge-files">
              {preview.files.slice(0, 8).map((f) => <li key={`${f.status}${f.path}`}><span className="merge-status">{f.status}</span><code>{f.path}</code></li>)}
              {preview.files.length > 8 ? <li className="merge-more">and {preview.files.length - 8} more</li> : null}
            </ul>
          ) : null}
          {preview.blockers.length ? <p className="merge-blocked" role="alert">Not now: {preview.blockers.join(' ')}</p> : null}
          {preview.identity ? <p className="merge-blocked" role="alert">{preview.identity}</p> : null}
          <div className="worktree-manage-actions">
            <button type="button" className="button-primary" disabled={busy || preview.mode === 'up-to-date' || preview.blockers.length > 0 || Boolean(preview.identity)}
              onClick={() => act(async () => finished((await api.mergeWorkspace(workspaceId, preview.fingerprint)).operation))}>Merge with Git</button>
            <button type="button" className="button-soft" disabled={busy} onClick={check}>Check again</button>
          </div>
        </>
      )}
      {operation?.stage === 'failed' && operation.error ? <p className="merge-blocked" role="alert">{operation.error}</p> : null}
      {error ? <p className="modal-error" role="alert">{error}</p> : null}
    </div>
  )
}
