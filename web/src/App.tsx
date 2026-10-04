import { FirstRun } from './components/FirstRun.tsx'
import { api } from './api.ts'
import { Workflows } from './components/Workflows.tsx'
import { Memory } from './components/Memory.tsx'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ConversationList } from './components/ConversationList.tsx'
import { ListResize, useListWidth } from './components/ListResize.tsx'
import { Files } from './components/Files.tsx'
import { NewConversation } from './components/NewConversation.tsx'
import { ProjectTabBar } from './components/ProjectTabBar.tsx'
import { Processes } from './components/Processes.tsx'
import { SubNav, type Section } from './components/SubNav.tsx'
import { usePinnedDocuments } from './usePinnedDocuments.ts'
import { DOCUMENTS_PREFIX } from './file-text.ts'
import { shortcutFor } from './shortcuts.ts'
import { ReleaseNotes } from './components/ReleaseNotes.tsx'
import { ReplyContext, type CommitOutcome } from './markdown/reply.tsx'
import type { FileTarget } from './markdown/file-links.ts'
import { TroubleshootingLink } from './components/TroubleshootingLink.tsx'
import { checkForUpdateNotice } from './update-notice.ts'
import { ThreadView } from './components/ThreadView.tsx'
import { useTheme } from './theme.ts'
import { useAppearance } from './appearance.ts'
import { AppearanceMenu } from './components/AppearanceMenu.tsx'
import { AppSettings } from './components/AppSettings.tsx'
import { playSound, soundForChanges, useAttention, useSoundSettings } from './sounds.ts'
import { notificationText, useNotifySettings } from './mac-notifications.ts'
import { Mark, SlidersIcon } from './components/icons.tsx'
import { native } from './native.ts'
import { needsYou } from './conversation-meta.ts'
import type { PageMode } from './api.ts'
import { PairingRequests, PhonePanel } from './components/PhonePanel.tsx'
import { PhoneNotify } from './components/PhoneNotify.tsx'
import { useCockpit } from './useCockpit.ts'
import { useProjects } from './useProjects.ts'
import { PreviewPane } from './components/PreviewPane.tsx'

const NO_THREADS: never[] = []

export function App({ page = { mode: 'local' } }: { page?: PageMode }) {
  const local = page.mode === 'local'
  const [director, setDirector] = useState<boolean>()
  useEffect(() => {
    if (!local) return
    let live = true
    api.director().then(({ show }) => { if (live) setDirector(show) }, () => { if (live) setDirector(false) })
    return () => { live = false }
  }, [local])
  // A paired phone sees every project's conversations and can reply, approve and stop.
  const phone = !local
  const cockpit = useCockpit(local)
  const projects = useProjects(cockpit.threads, cockpit.reportError)
  const theme = useTheme()
  const { appearance, update: updateAppearance } = useAppearance()
  const { sounds, setSounds } = useSoundSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const listWidth = useListWidth()
  const [listDraft, setListDraft] = useState<number>()
  const { notify, setNotify } = useNotifySettings()
  // Desktop only: the phone has its own notifications. The conversation you are looking at (open,
  // window focused) never chimes or notifies; every other one can.
  useAttention(local ? cockpit.threads : NO_THREADS, () => (document.hasFocus() ? cockpit.selectedId : undefined), (changes) => {
    const sound = soundForChanges(changes, sounds)
    if (sound) playSound(sound)
    for (const change of changes.filter((c) => notify[c.kind]).slice(0, 3)) {
      const thread = cockpit.threads.find((t) => t.meta.id === change.id)
      if (thread) native?.notify({ threadId: change.id, ...notificationText(thread, change.kind) })
    }
  })
  // The Dock icon: moving bars while any agent works, a badge with how many need you (every project).
  const working = cockpit.threads.filter((t) => t.status === 'working').length
  const needs = cockpit.threads.filter(needsYou).length
  useEffect(() => { if (local) native?.setActivity({ working, needs }) }, [local, working, needs])
  const [fileDraft, setFileDraft] = useState<{ projectPath: string; text: string; threadId?: string }>()
  const clearFileDraft = useCallback(() => setFileDraft(undefined), [])
  const [section, setSectionState] = useState<Section>('conversations')
  // Set only by the new-conversation pointer; any other way into Workflows opens the list.
  const [galleryFirst, setGalleryFirst] = useState(false)
  const setSection = useCallback((next: Section) => { setGalleryFirst(false); setSectionState(next) }, [])
  const openGallery = useCallback(() => { setGalleryFirst(true); setSectionState('workflows') }, [])
  const [phonePanelOpen, setPhonePanelOpen] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>()
  // Help → Release Notes, or the "Updated to" view after an update (lead set).
  const [releaseNotes, setReleaseNotes] = useState<{ lead?: string }>()
  // A reply's path:line link opens Files at that line (desktop only; Files stays on the Mac).
  const [reveal, setReveal] = useState<{ target: FileTarget; nonce: number }>()
  const openFileFromReply = useCallback((target: FileTarget) => { setReveal({ target, nonce: Date.now() }); setSection('files') }, [setSection])
  const pinnedDocuments = usePinnedDocuments(phone ? undefined : projects.active?.path, !phone)
  const replyProject = phone ? undefined : cockpit.detail?.meta.projectPath
  // A commit in a reply opens its page on the repository's host; without one the hash is copied.
  const openCommitFromReply = useCallback(async (hash: string): Promise<CommitOutcome> => {
    if (!replyProject) return 'missing'
    const commit = await api.gitCommit(replyProject, hash).catch(() => undefined)
    if (!commit) return 'missing'
    if (commit.url) { window.open(commit.url, '_blank', 'noopener'); return 'opened' }
    if (native) native.copyText(commit.hash.slice(0, 12))
    else await navigator.clipboard?.writeText(commit.hash.slice(0, 12)).catch(() => undefined)
    return 'copied'
  }, [replyProject])
  const replyContext = useMemo(() => ({ projectPath: replyProject, onOpenFile: openFileFromReply, onOpenCommit: openCommitFromReply }),
    [replyProject, openFileFromReply, openCommitFromReply])
  useEffect(() => local ? native?.onShowReleaseNotes(() => setReleaseNotes({})) : undefined, [local])
  const [updated, setUpdated] = useState<string>()
  useEffect(() => { if (local && native) void checkForUpdateNotice(native.appVersion).then(setUpdated) }, [local])
  useEffect(() => local ? native?.onPreviewOpen(setPreviewUrl) : undefined, [local])
  // A clicked Mac notification opens its conversation, in whichever project it belongs to.
  const threadsRef = useRef(cockpit.threads)
  threadsRef.current = cockpit.threads
  const { select: selectProject } = projects
  const { select: selectThread } = cockpit
  useEffect(() => local ? native?.onOpenThread((id) => {
    const thread = threadsRef.current.find((t) => t.meta.id === id)
    if (!thread) return
    selectProject(thread.meta.projectPath)
    setSection('conversations')
    selectThread(id)
  }) : undefined, [local, selectProject, selectThread, setSection])

  // ⌘1–9 project tabs, ⌥⌘1–5 sections (shortcuts.ts). The same moves as clicking the tab or section.
  const tabsRef = useRef(projects.tabs)
  tabsRef.current = projects.tabs
  useEffect(() => {
    if (phone) return
    const onKey = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor(event, tabsRef.current.length)
      if (!shortcut) return
      event.preventDefault()
      if (shortcut.kind === 'section') { setSection(shortcut.section); return }
      const tab = tabsRef.current[shortcut.index]
      if (!tab) return
      selectProject(tab.path)
      selectThread(undefined)
      setSection('conversations')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phone, selectProject, selectThread, setSection])

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

  if (local && director === undefined) return <div className="app first-run"><main className="first-run-body" role="status">Opening Cockpit…</main></div>
  if (local && director) return <FirstRun onDone={() => { setDirector(false); void projects.refresh(); cockpit.refresh() }} onCreated={(meta) => {
    void projects.open(meta.projectPath)
    cockpit.refresh()
    cockpit.select(meta.id)
    setDirector(false)
  }} />

  return (
    <div className={`app${projects.active ? ` tint-${projects.active.color}` : ''}`}>
      {phone ? (
        <header className="tabbar phone-bar">
          <Mark className="tabbar-mark" />
          <span className="phone-title">Cockpit</span>
        </header>
      ) : (
        <ProjectTabBar projects={{ ...projects,
          open: async (path) => { await projects.open(path); cockpit.select(undefined); setSection('conversations') },
          select: (path) => { projects.select(path); cockpit.select(undefined); setSection('conversations') },
        }} onImported={(meta) => { cockpit.refresh(); cockpit.select(meta.id); setSection('conversations') }} />
      )}
      <SubNav
        section={section}
        onSection={setSection}
        working={visible.filter((t) => t.status === 'working').length}
        appearance={<AppearanceMenu theme={theme.mode} onTheme={theme.set} appearance={appearance} onChange={updateAppearance} />}
        conversationsOnly={phone}
        runningProcesses={cockpit.processes.filter((p) => p.projectPath === activePath && p.status !== 'exited').length}
        pins={phone ? [] : [...(projects.active?.pinnedFiles ?? []), ...pinnedDocuments.map((name) => `${DOCUMENTS_PREFIX}${name}`)]}
        onOpenPin={(path) => openFileFromReply({ path })}
        tools={local ? <><PhonePanel status={cockpit.remote} onError={cockpit.reportError} onOpenChange={setPhonePanelOpen} />
          <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><SlidersIcon /></button></>
          : <PhoneNotify initiallyOn={page.mode === 'remote' && page.notifications} onError={cockpit.reportError} />}
      />
      {updated && !cockpit.error ? (
        <div className="toast update-toast" role="status">
          <span>{updated}</span>
          <button type="button" className="update-toast-notes" onClick={() => { setReleaseNotes({ lead: updated }); setUpdated(undefined) }}>What’s new</button>
          <button type="button" onClick={() => setUpdated(undefined)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {releaseNotes ? <ReleaseNotes lead={releaseNotes.lead} onClose={() => setReleaseNotes(undefined)} /> : null}
      {settingsOpen ? <AppSettings sounds={sounds} onSounds={setSounds} notify={notify} onNotify={setNotify} onClose={() => setSettingsOpen(false)} /> : null}
      {local && !phonePanelOpen && cockpit.remote?.pairings.length ? (
        <div className="pairing-banner" role="alert"><PairingRequests status={cockpit.remote} onError={cockpit.reportError} /></div>
      ) : null}
      {cockpit.error ? (
        <div className="toast" role="alert">
          <span>{cockpit.error}<TroubleshootingLink text={cockpit.error} /></span>
          <button type="button" onClick={() => cockpit.reportError(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      <ReplyContext.Provider value={replyContext}>
      <div className={`workspace${local && previewUrl ? ' has-preview' : ''}`}>
        <div className="workspace-main">
      {section === 'conversations' ? (
        <div className={`layout${selectedId ? ' has-selection' : ''}`} style={{ '--list-width': `${listDraft ?? listWidth.width}px` } as CSSProperties}>
          {phone ? null : <ListResize width={listWidth.width} onDraft={setListDraft} onResize={listWidth.setWidth} />}
          <ConversationList key={`list:${phone ? 'phone' : activePath ?? ''}`} threads={visible} selectedId={selectedId} onSelect={cockpit.select} rowShows={appearance.rows}
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
              onOpenGallery={openGallery}
              onOpenWorkflows={() => setSection('workflows')}
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
        <Files key={activePath ?? 'no-project'} project={projects.active} reveal={reveal}
          onPins={(pins) => { if (projects.active) void projects.setPinnedFiles(projects.active, pins) }} onAttach={(reference) => {
          if (!activePath) return
          setFileDraft({ projectPath: activePath, text: reference, threadId: selectedId })
          setSection('conversations')
        }} />
      ) : section === 'memory' ? (
        <Memory key={activePath ?? 'no-project'} project={projects.active} threads={cockpit.threads} onError={cockpit.reportError}
          onOpenThread={(id) => { cockpit.select(id); setSection('conversations') }} />
      ) : section === 'processes' ? (
        <Processes key={activePath ?? 'no-project'} project={projects.active} processes={cockpit.processes} onError={cockpit.reportError} />
      ) : (
        <Workflows key={activePath ?? 'no-project'} project={projects.active} onError={cockpit.reportError} initialGallery={galleryFirst}
          onOpenThread={(id) => { cockpit.refresh(); cockpit.select(id); setSection('conversations') }} />
      )}
        </div>
        {local && previewUrl ? <PreviewPane url={previewUrl} onClose={() => setPreviewUrl(undefined)} /> : null}
      </div>
      </ReplyContext.Provider>
    </div>
  )
}
