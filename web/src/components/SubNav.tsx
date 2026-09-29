import type { ReactNode } from 'react'
import type { ThemeMode } from '../theme.ts'
import { Bars, ChatIcon, FolderIcon, MonitorIcon, MoonIcon, SunIcon, WorkflowIcon } from './icons.tsx'

export type Section = 'conversations' | 'files' | 'workflows'

interface SubNavProps {
  section: Section
  onSection: (section: Section) => void
  working: number
  theme: ThemeMode
  onCycleTheme: () => void
  /** Extra tools on the right, e.g. the phone access button. */
  tools?: ReactNode
  /** Phone: only Conversations; files and workflows stay on the Mac. */
  conversationsOnly?: boolean
}

const THEME_LABEL: Record<ThemeMode, string> = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' }

export function SubNav({ section, onSection, working, theme, onCycleTheme, tools, conversationsOnly = false }: SubNavProps) {
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
        {tools}
        <button type="button" className="icon-button" aria-label={THEME_LABEL[theme]} title={THEME_LABEL[theme]} onClick={onCycleTheme}>
          {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <MonitorIcon />}
        </button>
      </div>
    </nav>
  )
}
