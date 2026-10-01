import type { ReactNode } from 'react'
import { Bars, ChatIcon, FolderIcon, MemoryIcon, TerminalIcon, WorkflowIcon } from './icons.tsx'

export type Section = 'conversations' | 'files' | 'workflows' | 'memory' | 'processes'

interface SubNavProps {
  section: Section
  onSection: (section: Section) => void
  working: number
  /** The Appearance popover, last on the right. */
  appearance: ReactNode
  /** Extra tools on the right, e.g. the phone access button. */
  tools?: ReactNode
  /** Phone: only Conversations; files, workflows and processes stay on the Mac. */
  conversationsOnly?: boolean
  /** Running processes in the active project, shown on the Processes button. */
  runningProcesses?: number
}

export function SubNav({ section, onSection, working, appearance, tools, conversationsOnly = false, runningProcesses = 0 }: SubNavProps) {
  const item = (id: Section, icon: ReactNode, label: string, extra?: ReactNode) => (
    <button type="button" role="tab" aria-selected={section === id} className="subnav-item" onClick={() => onSection(id)}>
      {icon}
      {label}
      {extra}
    </button>
  )

  return (
    <nav className="subnav">
      <div className="subnav-items" role="tablist" aria-label="Sections">
        {item(
          'conversations',
          <ChatIcon />,
          'Conversations',
          working > 0 ? (
            <span className="subnav-badge" aria-label={`${working} working`}>
              <Bars live />
              {working}
            </span>
          ) : null,
        )}
        {conversationsOnly ? null : item('files', <FolderIcon />, 'Files')}
        {conversationsOnly ? null : item('workflows', <WorkflowIcon />, 'Workflows')}
        {conversationsOnly ? null : item('memory', <MemoryIcon />, 'Memory')}
      </div>
      <div className="subnav-tools">
        {conversationsOnly ? null : (
          <button type="button" className={`icon-button processes-button${runningProcesses ? ' has-running' : ''}`} aria-pressed={section === 'processes'}
            aria-label={runningProcesses ? `Processes (${runningProcesses} running)` : 'Processes'} title="Processes"
            onClick={() => onSection(section === 'processes' ? 'conversations' : 'processes')}>
            <TerminalIcon />
            {runningProcesses ? <span className="processes-badge">{runningProcesses}</span> : null}
          </button>
        )}
        {tools}
        {appearance}
      </div>
    </nav>
  )
}
