import type { ReactNode } from 'react'
import { SECTION_ORDER } from '../shortcuts.ts'
import { Bars, ChatIcon, FileIcon, FolderIcon, MemoryIcon, TerminalIcon, WorkflowIcon } from './icons.tsx'
import { fileName, spaceOf } from '../file-text.ts'

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
  /** Pinned project files and documents ("documents:<name>"), reopened from any section. */
  pins?: readonly string[]
  onOpenPin?: (path: string) => void
}

export function SubNav({ section, onSection, working, appearance, tools, conversationsOnly = false, runningProcesses = 0, pins = [], onOpenPin }: SubNavProps) {
  const item = (id: Section, icon: ReactNode, label: string, extra?: ReactNode) => (
    <button type="button" role="tab" aria-selected={section === id} className="subnav-item" title={conversationsOnly ? undefined : `${label} (⌥⌘${SECTION_ORDER.indexOf(id) + 1})`} onClick={() => onSection(id)}>
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
      {pins.length > 0 && onOpenPin ? (
        <div className="subnav-pins" role="group" aria-label="Pinned files">
          {pins.map((path) => (
            <button key={path} type="button" className="subnav-pin" title={spaceOf(path).space === 'documents' ? `Your documents / ${fileName(path)}` : path} onClick={() => onOpenPin(path)}>
              <FileIcon />
              <span>{fileName(path)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="subnav-tools">
        {conversationsOnly ? null : (
          <button type="button" className={`icon-button processes-button${runningProcesses ? ' has-running' : ''}`} aria-pressed={section === 'processes'}
            aria-label={runningProcesses ? `Processes (${runningProcesses} running)` : 'Processes'} title={`Processes (⌥⌘${SECTION_ORDER.indexOf('processes') + 1})`}
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
