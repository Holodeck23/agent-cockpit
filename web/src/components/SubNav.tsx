import type { ReactNode } from 'react'
import type { ThemeMode } from '../theme.ts'
import { Bars, ChatIcon, FolderIcon, MonitorIcon, MoonIcon, SunIcon, TerminalIcon, WorkflowIcon } from './icons.tsx'

export type Section = 'conversations' | 'files' | 'workflows' | 'processes'

interface SubNavProps {
  section: Section
  onSection: (section: Section) => void
  working: number
  theme: ThemeMode
  onCycleTheme: () => void
  /** Extra tools on the right, e.g. the phone access button. */
  tools?: ReactNode
  /** Phone: only Conversations; files, workflows and processes stay on the Mac. */
  conversationsOnly?: boolean
  /** Running processes in the active project, shown on the Processes button. */
  runningProcesses?: number
}

const THEME_LABEL: Record<ThemeMode, string> = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' }

export function SubNav({ section, onSection, working, theme, onCycleTheme, tools, conversationsOnly = false, runningProcesses = 0 }: SubNavProps) {
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
        <button type="button" className="icon-button" aria-label={THEME_LABEL[theme]} title={THEME_LABEL[theme]} onClick={onCycleTheme}>
          {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <MonitorIcon />}
        </button>
      </div>
    </nav>
  )
}
