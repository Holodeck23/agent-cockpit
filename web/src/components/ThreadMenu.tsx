import type { NormalizedEvent } from '../../../server/agents/types.ts'
import { native } from '../native.ts'
import { usePopover } from '../usePopover.ts'
import { usageLine } from '../usage.ts'
import { FileIcon, MoreIcon } from './icons.tsx'

type UsageEvent = Extract<NormalizedEvent, { kind: 'usage' }>

interface ThreadMenuProps {
  transcriptPath: string
  usage: UsageEvent | undefined
  completed: boolean
  onToggleCompleted: () => void
}

export function ThreadMenu({ transcriptPath, usage, completed, onToggleCompleted }: ThreadMenuProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()

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
          {usage ? (
            <p className="menu-note">{usageLine(usage)}</p>
          ) : null}
          <p className="menu-note menu-path" title={transcriptPath}>
            {transcriptPath}
          </p>
        </div>
      ) : null}
    </div>
  )
}
