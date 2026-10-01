import { useState } from 'react'
import type { NormalizedEvent } from '../../../server/agents/types.ts'
import { native } from '../native.ts'
import { usePopover } from '../usePopover.ts'
import { usageLine } from '../usage.ts'
import { FileIcon, MoreIcon, TrashIcon } from './icons.tsx'

type UsageEvent = Extract<NormalizedEvent, { kind: 'usage' }>

interface ThreadMenuProps {
  transcriptPath: string
  usage: UsageEvent | undefined
  completed: boolean
  onToggleCompleted: () => void
  /** Absent on the phone, where conversations can't be deleted. */
  onMarkUnread?: () => void
  onDelete?: () => Promise<void>
  /** A turn is running; deleting stops the agent first. */
  running?: boolean
  /** Revision the running session started with (and its text), and the project's current one. */
  instructions?: { readonly session?: number; readonly current?: number; readonly sessionText?: string }
}

function instructionsNote({ session, current }: { session?: number; current?: number }): string | undefined {
  if (!session && !current) return undefined
  if (session === current) return `Project instructions: revision ${session}`
  if (!current) return 'Project instructions were cleared; that applies when the agent next starts.'
  return `Project instructions: revision ${current} is saved; it applies when the agent next starts${session ? ` (this session has ${session})` : ''}.`
}

export function ThreadMenu({ transcriptPath, usage, completed, onToggleCompleted, onMarkUnread, onDelete, running = false, instructions }: ThreadMenuProps) {
  const instructionLine = instructions ? instructionsNote(instructions) : undefined
  const { open, setOpen: setPopover, ref } = usePopover<HTMLDivElement>()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const setOpen = (next: boolean): void => { setPopover(next); if (!next) setConfirming(false) }

  if (open && confirming && onDelete) {
    return (
      <div className="thread-menu" ref={ref}>
        <button type="button" className="icon-button" aria-label="More" aria-expanded onClick={() => setOpen(false)}>
          <MoreIcon />
        </button>
        <div className="menu menu-right delete-confirm" role="alertdialog" aria-label="Delete conversation">
          <p className="delete-title">Delete this conversation?</p>
          <p className="menu-note">Its messages, decisions and transcript file are removed from this Mac.{running ? ' The agent working on it is stopped first.' : ''} Project files and running processes are not touched.</p>
          <div className="delete-actions">
            <button type="button" className="button-soft" disabled={deleting} onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="button-danger" disabled={deleting}
              onClick={() => { setDeleting(true); void onDelete().finally(() => { setDeleting(false); setOpen(false) }) }}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="thread-menu" ref={ref}>
      <button type="button" className="icon-button" aria-label="More" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreIcon />
      </button>
      {open ? (
        <div className="menu menu-right" role="menu" aria-label="Conversation">
          {native ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                native?.revealTranscript(transcriptPath)
                setOpen(false)
              }}
            >
              <FileIcon />
              Show transcript in Finder
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onToggleCompleted()
              setOpen(false)
            }}
          >
            {completed ? 'Reopen conversation' : 'Mark as complete'}
          </button>
          {onMarkUnread ? (
            <button type="button" role="menuitem" className="menu-item" onClick={() => { onMarkUnread(); setOpen(false) }}>
              Mark as unread
            </button>
          ) : null}
          {onDelete ? (
            <button type="button" role="menuitem" className="menu-item menu-danger" onClick={() => setConfirming(true)}>
              <TrashIcon />
              Delete conversation…
            </button>
          ) : null}
          {usage ? (
            <p className="menu-note">{usageLine(usage)}</p>
          ) : null}
          {instructionLine ? <p className="menu-note">{instructionLine}</p> : null}
          {instructions?.sessionText ? (
            <details className="menu-note">
              <summary>What this session received</summary>
              <pre>{instructions.sessionText}</pre>
            </details>
          ) : null}
          <p className="menu-note menu-path" title={transcriptPath}>
            {/* The row is rtl so a long path clips at its start; the isolate keeps the leading "/" at the front. */}
            <bdi dir="ltr">{transcriptPath}</bdi>
          </p>
        </div>
      ) : null}
    </div>
  )
}
