import { useState } from 'react'
import { ConversationList } from './components/ConversationList.tsx'
import { FolderIcon, WorkflowIcon } from './components/icons.tsx'
import { NewConversation } from './components/NewConversation.tsx'
import { Placeholder } from './components/Placeholder.tsx'
import { ProjectTabBar } from './components/ProjectTabBar.tsx'
import { SubNav, type Section } from './components/SubNav.tsx'
import { ThreadView } from './components/ThreadView.tsx'
import { useTheme } from './theme.ts'
import { useCockpit } from './useCockpit.ts'
import { useProjects } from './useProjects.ts'

export function App() {
  const cockpit = useCockpit()
  const projects = useProjects(cockpit.threads, cockpit.reportError)
  const theme = useTheme()
  const [section, setSection] = useState<Section>('conversations')

  const activePath = projects.active?.path
  const visible = activePath ? cockpit.threads.filter((t) => t.meta.projectPath === activePath) : cockpit.threads
  const selectedId = visible.some((t) => t.meta.id === cockpit.selectedId) ? cockpit.selectedId : undefined

  return (
    <div className="app">
      <ProjectTabBar projects={projects} />
      <SubNav
        section={section}
        onSection={setSection}
        working={visible.filter((t) => t.status === 'working').length}
        theme={theme.mode}
        onCycleTheme={theme.cycle}
      />
      {cockpit.error ? (
        <div className="toast" role="alert">
          {cockpit.error}
          <button type="button" onClick={() => cockpit.reportError(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {section === 'conversations' ? (
        <div className="layout">
          <ConversationList key={`list:${activePath ?? ''}`} threads={visible} selectedId={selectedId} onSelect={cockpit.select} />
          {selectedId && cockpit.detail ? (
            <ThreadView
              detail={cockpit.detail}
              streaming={cockpit.streaming}
              processes={cockpit.processes.filter((p) => p.projectPath === cockpit.detail?.meta.projectPath)}
              onError={cockpit.reportError}
            />
          ) : (
            <NewConversation
              key={`new:${activePath ?? ''}`}
              project={projects.active}
              onOpenProject={projects.open}
              onError={cockpit.reportError}
              onCreated={(meta) => {
                cockpit.refresh()
                projects.select(meta.projectPath)
                cockpit.select(meta.id)
              }}
            />
          )}
        </div>
      ) : section === 'files' ? (
        <Placeholder icon={<FolderIcon />} title="Files">
          Browse this project's files and hand them to a conversation. Coming with workflows.
        </Placeholder>
      ) : (
        <Placeholder icon={<WorkflowIcon />} title="Workflows">
          Saved, repeatable jobs you can run or schedule for this project. On the way.
        </Placeholder>
      )}
    </div>
  )
}
