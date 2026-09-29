import { Workflows } from './components/Workflows.tsx'
import { useCallback, useState } from 'react'
import { ConversationList } from './components/ConversationList.tsx'
import { Files } from './components/Files.tsx'
import { NewConversation } from './components/NewConversation.tsx'
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
  const [fileDraft, setFileDraft] = useState<{ projectPath: string; text: string; threadId?: string }>()
  const clearFileDraft = useCallback(() => setFileDraft(undefined), [])
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
          {selectedId ? cockpit.detail?.meta.id === selectedId ? (
            <ThreadView
              initialDraft={fileDraft?.threadId === selectedId ? fileDraft?.text : undefined}
              onDraftLoaded={clearFileDraft}
              onBrowseFiles={() => setSection('files')}
              detail={cockpit.detail}
              streaming={cockpit.streaming}
              processes={cockpit.processes.filter((p) => p.projectPath === cockpit.detail?.meta.projectPath)}
              onError={cockpit.reportError}
            />
          ) : (
            <main className="thread" role="status">Loading conversation…</main>
          ) : (
            <NewConversation
              key={`new:${activePath ?? ''}`}
              project={projects.active}
              initialDraft={fileDraft && !fileDraft.threadId && fileDraft.projectPath === activePath ? fileDraft.text : undefined}
              onDraftLoaded={clearFileDraft}
              onBrowseFiles={() => setSection('files')}
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
        <Files key={activePath ?? 'no-project'} project={projects.active} onAttach={(reference) => {
          if (!activePath) return
          setFileDraft({ projectPath: activePath, text: reference, threadId: selectedId })
          setSection('conversations')
        }} />
      ) : (
        <Workflows key={activePath ?? 'no-project'} project={projects.active} onError={cockpit.reportError}
          onOpenThread={(id) => { cockpit.refresh(); cockpit.select(id); setSection('conversations') }} />
      )}
    </div>
  )
}
