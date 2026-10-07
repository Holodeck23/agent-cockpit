import { useState } from 'react'
import type { Project, ThreadSummary } from '../api.ts'
import type { Workspaces } from '../useWorkspaces.ts'
import { activityIn, healthLabel, MAIN_CHECKOUT, worktreeLabel, type WorkspaceActivity } from '../workspaces.ts'
import { usePopover } from '../usePopover.ts'
import { BranchIcon, CheckIcon, ChevronDownIcon, PlusIcon } from './icons.tsx'
import { NewWorktreeDialog } from './NewWorktreeDialog.tsx'
import { ManageWorktreesDialog } from './ManageWorktreesDialog.tsx'

// The workspace selector under the project (W12.2 M1): the main checkout and each worktree, with
// a dot for work running or waiting on you, a missing state, "New worktree…", and interrupted
// creates with Recover and Dismiss. Choosing one changes what Files, Changes, branch and new
// conversations look at; it never moves a run that is already going.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function Dot({ activity }: { activity: WorkspaceActivity }) {
  if (activity.needsYou > 0) return <span className="workspace-dot needs" role="img" aria-label={`${activity.needsYou} need${activity.needsYou === 1 ? 's' : ''} you`} title="A conversation here needs you" />
  if (activity.working > 0) return <span className="workspace-dot working" role="img" aria-label={`${activity.working} working`} title="A conversation here is working" />
  return null
}

export function WorkspaceSelector({ project, workspaces, threads, onSelect, onError }: {
  project: Project
  workspaces: Workspaces
  /** This project's conversations, for the activity dots. */
  threads: readonly ThreadSummary[]
  /** Chooses a worktree's ID, or undefined for the main checkout. */
  onSelect: (id: string | undefined) => void
  onError: (message: string) => void
}) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState(false)
  const [busyOp, setBusyOp] = useState('')
  const { selection, worktrees, pending } = workspaces
  const primaryId = project.workspaceId
  const mainActivity = activityIn(threads, primaryId, primaryId)
  const selectedActivity = selection.kind === 'primary' ? mainActivity : activityIn(threads, selection.id, primaryId)
  // Another workspace's attention shows on the closed button too, so nothing waits unseen.
  const elsewhere = worktrees.some((w) => w.id !== selection.id && activityIn(threads, w.id, primaryId).needsYou > 0)
    || (selection.kind !== 'primary' && mainActivity.needsYou > 0)

  const choose = (id: string | undefined): void => { setOpen(false); onSelect(id) }
  const operate = (id: string, run: () => Promise<void>): void => {
    setBusyOp(id)
    run().catch((e: unknown) => onError(message(e))).finally(() => setBusyOp(''))
  }

  return (
    <div className="workspace-selector">
      <div className="workspace-picker" ref={ref}>
        <button type="button" className={`workspace-button${selection.kind === 'missing' ? ' missing' : ''}`} aria-haspopup="listbox" aria-expanded={open}
          aria-label={`Workspace: ${selection.label}`} title="Which checkout Files, Changes and new conversations use" onClick={() => setOpen(!open)}>
          <BranchIcon />
          <span className="workspace-name">{selection.label}</span>
          {selection.kind === 'worktree' && selection.workspace?.branch ? <span className="workspace-branch">{selection.workspace.branch}</span> : null}
          <Dot activity={selectedActivity} />
          {elsewhere ? <span className="workspace-dot needs" role="img" aria-label="Another workspace needs you" title="Another workspace needs you" /> : null}
          <ChevronDownIcon className="chevron" />
        </button>
        {open ? (
          <div className="workspace-panel" role="listbox" aria-label="Workspaces">
            <button type="button" role="option" aria-selected={selection.kind === 'primary'} className="workspace-row" onClick={() => choose(undefined)}>
              <BranchIcon />
              <span className="workspace-row-text"><strong>{MAIN_CHECKOUT}</strong><small>{project.name}</small></span>
              <Dot activity={mainActivity} />
              {selection.kind === 'primary' ? <CheckIcon className="workspace-check" /> : null}
            </button>
            {worktrees.map((w) => (
              <button key={w.id} type="button" role="option" aria-selected={selection.id === w.id} className="workspace-row" onClick={() => choose(w.id)}>
                <BranchIcon />
                <span className="workspace-row-text"><strong>{worktreeLabel(w)}</strong><small>{w.branch ?? 'no branch'}{healthLabel(workspaces.health[w.id]) ? ` · ${healthLabel(workspaces.health[w.id])}` : ''}</small></span>
                <Dot activity={activityIn(threads, w.id, primaryId)} />
                {selection.id === w.id ? <CheckIcon className="workspace-check" /> : null}
              </button>
            ))}
            {selection.kind === 'missing' ? (
              <div role="option" aria-selected="true" aria-disabled="true" className="workspace-row missing">
                <BranchIcon />
                <span className="workspace-row-text"><strong>{selection.label}</strong><small>This workspace no longer exists. Pick another to keep working.</small></span>
              </div>
            ) : null}
            <button type="button" className="workspace-row workspace-new" onClick={() => { setOpen(false); setCreating(true) }}>
              <PlusIcon />
              <span className="workspace-row-text"><strong>New worktree…</strong></span>
            </button>
            {worktrees.length || workspaces.archived.length ? (
              <button type="button" className="workspace-row workspace-manage" onClick={() => { setOpen(false); setManaging(true) }}>
                <BranchIcon />
                <span className="workspace-row-text"><strong>Manage worktrees…</strong></span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {selection.kind === 'missing' ? (
        <p className="workspace-missing" role="alert">
          {selection.label.replace(/ \(missing\)$/, '')} no longer exists, so nothing is sent there. Choose a workspace above; your drafts are kept.
        </p>
      ) : null}
      {pending.length ? (
        <ul className="workspace-pending" aria-label="Interrupted worktrees">
          {pending.map((op) => (
            <li key={op.id}>
              <span className="workspace-pending-text">
                <strong>{op.name}</strong>
                <small>{op.state === 'recoverable' ? 'Interrupted while it was being created. Git has it.' : 'Interrupted while it was being created.'}{op.detail ? ` ${op.detail}` : ''}</small>
              </span>
              <span className="workspace-pending-actions">
                {op.state === 'recoverable' ? (
                  <button type="button" className="button-soft" disabled={busyOp === op.id} onClick={() => operate(op.id, () => workspaces.recover(op.id))}>Recover</button>
                ) : null}
                <button type="button" className="button-soft" disabled={busyOp === op.id} onClick={() => operate(op.id, () => workspaces.dismiss(op.id))}>Dismiss</button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {managing ? <ManageWorktreesDialog project={project} workspaces={workspaces} threads={threads} onClose={() => setManaging(false)} /> : null}
      {creating && project.projectId ? (
        <NewWorktreeDialog projectId={project.projectId} projectName={project.name}
          onCreate={async (body) => { const made = await workspaces.create(body); onSelect(made.id) }} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  )
}
