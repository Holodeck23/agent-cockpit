import { Workflows } from './components/Workflows.tsx'
import { useCallback, useEffect, useState } from 'react'
import { ConversationList } from './components/ConversationList.tsx'
import { Files } from './components/Files.tsx'
import { NewConversation } from './components/NewConversation.tsx'
import { ProjectTabBar } from './components/ProjectTabBar.tsx'
import { Processes } from './components/Processes.tsx'
import { SubNav, type Section } from './components/SubNav.tsx'
import { ThreadView } from './components/ThreadView.tsx'
import { useTheme } from './theme.ts'
import { Mark } from './components/icons.tsx'
import type { PageMode } from './api.ts'
import { PairingRequests, PhonePanel } from './components/PhonePanel.tsx'
import { PhoneNotify } from './components/PhoneNotify.tsx'
import { useCockpit } from './useCockpit.ts'
import { useProjects } from './useProjects.ts'

export function App({ page = { mode: 'local' } }: { page?: PageMode }) {
  const local = page.mode === 'local'
  // A paired phone sees every project's conversations and can reply, approve and stop.
  const phone = !local
  const cockpit = useCockpit(local)
  const projects = useProjects(cockpit.threads, cockpit.reportError)
  const theme = useTheme()
  const [fileDraft, setFileDraft] = useState<{ projectPath: string; text: string; threadId?: string }>()
  const clearFileDraft = useCallback(() => setFileDraft(undefined), [])
  const [section, setSection] = useState<Section>('conversations')
  const [phonePanelOpen, setPhonePanelOpen] = useState(false)

  const activePath = projects.active?.path
  const visible = activePath && !phone ? cockpit.threads.filter((t) => t.meta.projectPath === activePath) : cockpit.threads
  // A tapped notification opens /?thread=<id>: select it once, then tidy the address.
  const { select } = cockpit
  useEffect(() => {
    const thread = new URLSearchParams(window.location.search).get('thread')
    if (!thread) return
    select(thread)
    window.history.replaceState(null, '', '/')
  }, [select])
  const detailProject = projects.all.find((p) => p.path === cockpit.detail?.meta.projectPath)
  const projectName = (path: string): string => projects.all.find((p) => p.path === path)?.name ?? path.split('/').pop() ?? path
  const selectedId = visible.some((t) => t.meta.id === cockpit.selectedId) ? cockpit.selectedId : undefined

  return (
    <div className="app">
      {phone ? (
        <header className="tabbar phone-bar">
          <Mark className="tabbar-mark" />
          <span className="phone-title">Cockpit</span>
        </header>
      ) : (
        <ProjectTabBar projects={projects} />
      )}
      <SubNav
        section={section}
        onSection={setSection}
        working={visible.filter((t) => t.status === 'working').length}
        theme={theme.mode}
        onCycleTheme={theme.cycle}
        conversationsOnly={phone}
        runningProcesses={cockpit.processes.filter((p) => p.projectPath === activePath && p.status !== 'exited').length}
        tools={local ? <PhonePanel status={cockpit.remote} onError={cockpit.reportError} onOpenChange={setPhonePanelOpen} />
          : <PhoneNotify initiallyOn={page.mode === 'remote' && page.notifications} onError={cockpit.reportError} />}
      />
      {local && !phonePanelOpen && cockpit.remote?.pairings.length ? (
        <div className="pairing-banner" role="alert"><PairingRequests status={cockpit.remote} onError={cockpit.reportError} /></div>
      ) : null}
      {cockpit.error ? (
        <div className="toast" role="alert">
          {cockpit.error}
          <button type="button" onClick={() => cockpit.reportError(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {section === 'conversations' ? (
        <div className={`layout${selectedId ? ' has-selection' : ''}`}>
          <ConversationList key={`list:${phone ? 'phone' : activePath ?? ''}`} threads={visible} selectedId={selectedId} onSelect={cockpit.select}
            {...(phone ? { projectName, canCreate: false } : {})} />
          {selectedId ? cockpit.detail?.meta.id === selectedId ? (
            <ThreadView
              initialDraft={fileDraft?.threadId === selectedId ? fileDraft?.text : undefined}
              onDraftLoaded={clearFileDraft}
              onBrowseFiles={() => setSection('files')}
              detail={cockpit.detail}
              streaming={cockpit.streaming}
              processes={cockpit.processes.filter((p) => p.projectPath === cockpit.detail?.meta.projectPath)}
              onError={cockpit.reportError}
              instructionsRevision={detailProject?.instructions ? detailProject.instructionsRevision : undefined}
              phone={phone}
              onBack={() => cockpit.select(undefined)}
            />
          ) : (
            <main className="thread" role="status">Loading conversation…</main>
          ) : phone ? (
            <main className="thread thread-pick">Pick a conversation to follow it here.</main>
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
      ) : section === 'processes' ? (
        <Processes key={activePath ?? 'no-project'} project={projects.active} processes={cockpit.processes} onError={cockpit.reportError} />
      ) : (
        <Workflows key={activePath ?? 'no-project'} project={projects.active} onError={cockpit.reportError}
          onOpenThread={(id) => { cockpit.refresh(); cockpit.select(id); setSection('conversations') }} />
      )}
    </div>
  )
}
