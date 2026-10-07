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
import { isWorking, needsYou } from './conversation-meta.ts'
import type { PageMode, ThreadMeta } from './api.ts'
import { PairingRequests, PhonePanel } from './components/PhonePanel.tsx'
import { PhoneNotify } from './components/PhoneNotify.tsx'
import { useCockpit } from './useCockpit.ts'
import { useProjects } from './useProjects.ts'
import { useWorkspaces } from './useWorkspaces.ts'
import { WorkspaceSelector } from './components/WorkspaceSelector.tsx'
import { currentWorkspaceOf, folderOf, isActiveWorktree, isUsable, labelOf, MAIN_CHECKOUT, saveSelected, sendTarget, threadsIn, type ThreadWorkspace } from './workspaces.ts'
import { PreviewPane } from './components/PreviewPane.tsx'
import { BrowserPane } from './components/BrowserPane.tsx'
import { loadLayouts, openPage, saveLayouts, updatePage, type LayoutMap, type PaneLayout } from './browser-layout.ts'
import { forgetPreview, previewKey, previewUrl, rememberPreview, type PreviewMap } from './preview-owner.ts'
import type { PreviewOpen } from '../../server/preview/types.ts'

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
  const workspaces = useWorkspaces(phone ? undefined : projects.active, local)
  const { selection } = workspaces
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
  const working = cockpit.threads.filter((t) => isWorking(t.status)).length
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
  const [previews, setPreviews] = useState<PreviewMap>({})
  // A4: the conversation list can be hidden; the Conversations tab then opens it as a dropdown.
  const [listHidden, setListHidden] = useState(() => { try { return localStorage.getItem('cockpit:list-hidden') === 'true' } catch { return false } })
  const [listOpen, setListOpen] = useState(false)
  const focusSectionTab = (): void => { requestAnimationFrame(() => document.getElementById('section-conversations')?.focus()) }
  const setHidden = (hidden: boolean): void => {
    setListHidden(hidden)
    setListOpen(false)
    try { localStorage.setItem('cockpit:list-hidden', String(hidden)) } catch { /* not kept across launches */ }
    if (hidden) focusSectionTab()
  }
  const closeList = (): void => { setListOpen(false); focusSectionTab() }
  useEffect(() => {
    if (phone || section !== 'conversations') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Backslash' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      setHidden(!listHidden)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phone, section, listHidden])
  // The open dropdown takes focus (its search field) and closes on a click anywhere else.
  useEffect(() => {
    if (!listOpen) return
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.list-dropdown input[type="search"]')?.focus())
    const outside = (event: MouseEvent): void => {
      const target = event.target as Element | null
      if (!target?.closest('.list-dropdown, #section-conversations')) setListOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [listOpen])
  // The in-app browser (wave 9) where the desktop app has one; the iframe preview otherwise.
  const inAppBrowser = local && Boolean(native?.browser)
  const [layouts, setLayouts] = useState<LayoutMap>(() => (inAppBrowser ? loadLayouts() : {}))
  const [openNonce, setOpenNonce] = useState(0)
  useEffect(() => { if (inAppBrowser) saveLayouts(layouts) }, [inAppBrowser, layouts])
  const showPage = useCallback((preview: PreviewOpen) => {
    if (inAppBrowser) {
      setLayouts((current) => openPage(current, previewKey(preview), preview.url))
      // The host already loaded an agent's preview in that page; asking again would load it twice.
      if (!preview.loaded) setOpenNonce((n) => n + 1)
    }
    else setPreviews((current) => rememberPreview(current, preview))
  }, [inAppBrowser])
  // Help → Release Notes, or the "Updated to" view after an update (lead set).
  const [releaseNotes, setReleaseNotes] = useState<{ lead?: string }>()
  // A reply's path:line link opens Files at that line (desktop only; Files stays on the Mac).
  const [reveal, setReveal] = useState<{ target: FileTarget; nonce: number }>()
  const openFileFromReply = useCallback((target: FileTarget) => { setReveal({ target, nonce: Date.now() }); setSection('files') }, [setSection])
  const pinnedDocuments = usePinnedDocuments(phone ? undefined : projects.active?.path, !phone)
  const replyProject = phone ? undefined : cockpit.detail?.meta.projectPath
  // A conversation that works in a worktree reads its files and commits there.
  const replyWorkspace = phone ? undefined : workspaces.worktrees.find((w) => w.id === cockpit.detail?.meta.workspaceId)?.id
  // A commit in a reply opens its page on the repository's host; without one the hash is copied.
  const openCommitFromReply = useCallback(async (hash: string): Promise<CommitOutcome> => {
    if (!replyProject) return 'missing'
    const commit = await api.gitCommit(replyProject, hash, replyWorkspace).catch(() => undefined)
    if (!commit) return 'missing'
    if (commit.url) { window.open(commit.url, '_blank', 'noopener'); return 'opened' }
    if (native) native.copyText(commit.hash.slice(0, 12))
    else await navigator.clipboard?.writeText(commit.hash.slice(0, 12)).catch(() => undefined)
    return 'copied'
  }, [replyProject, replyWorkspace])
  const replyThread = phone ? undefined : cockpit.detail?.meta.id
  // G5: a web link in a reply opens beside the chat, in that conversation's own page.
  const openWebFromReply = useCallback((url: string) => {
    if (replyProject && replyThread) showPage({ url, projectPath: replyProject, threadId: replyThread })
  }, [replyProject, replyThread, showPage])
  const replyContext = useMemo(() => ({ projectPath: replyProject, workspaceId: replyWorkspace, onOpenFile: openFileFromReply, onOpenCommit: openCommitFromReply,
    ...(inAppBrowser ? { onOpenWeb: openWebFromReply } : {}) }),
    [replyProject, replyWorkspace, openFileFromReply, openCommitFromReply, inAppBrowser, openWebFromReply])
  useEffect(() => local ? native?.onShowReleaseNotes(() => setReleaseNotes({})) : undefined, [local])
  const [updated, setUpdated] = useState<string>()
  useEffect(() => { if (local && native) void checkForUpdateNotice(native.appVersion).then(setUpdated) }, [local])
  useEffect(() => local ? native?.onPreviewOpen(showPage) : undefined, [local, showPage])
  // A clicked Mac notification opens its conversation, in whichever project it belongs to.
  const threadsRef = useRef(cockpit.threads)
  threadsRef.current = cockpit.threads
  const projectsRef = useRef(projects.all)
  projectsRef.current = projects.all
  // Opening a conversation from elsewhere shows the workspace it works in, so a reply does not move it.
  const focusWorkspaceOf = useCallback((meta: ThreadMeta): void => {
    const primary = projectsRef.current.find((p) => p.path === meta.projectPath)?.workspaceId
    saveSelected(meta.projectPath, meta.workspaceId && meta.workspaceId !== primary ? meta.workspaceId : undefined)
  }, [])
  const { select: selectProject } = projects
  const { select: selectThread } = cockpit
  useEffect(() => local ? native?.onOpenThread((id) => {
    const thread = threadsRef.current.find((t) => t.meta.id === id)
    if (!thread) return
    focusWorkspaceOf(thread.meta)
    selectProject(thread.meta.projectPath)
    setSection('conversations')
    selectThread(id)
  }) : undefined, [local, selectProject, selectThread, setSection, focusWorkspaceOf])

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
  const projectThreads = activePath && !phone ? cockpit.threads.filter((t) => t.meta.projectPath === activePath) : cockpit.threads
  // Once the project has a worktree the list follows the selected workspace; a conversation that ran in several shows under each.
  const primaryId = projects.active?.workspaceId
  const filtering = !phone && (workspaces.worktrees.length > 0 || selection.kind !== 'primary')
  const visible = filtering ? threadsIn(projectThreads, selection.id, primaryId) : projectThreads
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
  // An open conversation stays open when another workspace is chosen: the choice moves where its next message goes (W12.2).
  const selectedId = projectThreads.some((t) => t.meta.id === cockpit.selectedId) ? cockpit.selectedId : undefined
  const hideList = listHidden && !phone
  // A page's website data lives with its folder: a conversation's own workspace, else the selected one.
  const previewThread = section === 'conversations' && selectedId ? cockpit.threads.find((t) => t.meta.id === selectedId) : undefined
  const previewFolder = !projects.active ? undefined
    : previewThread ? folderOf(workspaces.list, projects.active, previewThread.meta.workspaceId)
    : selection.kind === 'worktree' ? selection.folder : projects.active.path
  const previewTarget = activePath ? {
    projectPath: activePath,
    ...(previewFolder && previewFolder !== activePath ? { cwd: previewFolder } : {}),
    ...(section === 'conversations' && selectedId ? { threadId: selectedId } : {}),
  } : undefined
  const activePreviewUrl = previewUrl(previews, previewTarget)
  const activePageKey = previewTarget ? previewKey(previewTarget) : undefined
  const activeLayout = inAppBrowser && activePageKey ? layouts[activePageKey] : undefined
  const browserOpen = Boolean(activeLayout?.visible && previewTarget)
  const changeLayout = useCallback((change: Partial<PaneLayout>) => {
    if (activePageKey) setLayouts((current) => updatePage(current, activePageKey, change))
  }, [activePageKey])
  const openProcessSite = (preview: PreviewOpen): void => {
    showPage(preview)
    if (preview.threadId) {
      const meta = cockpit.threads.find((t) => t.meta.id === preview.threadId)?.meta
      if (meta) focusWorkspaceOf(meta)
      selectProject(preview.projectPath)
      selectThread(preview.threadId)
      setSection('conversations')
    }
  }

  if (local && director === undefined) return <div className="app first-run"><main className="first-run-body" role="status">Opening Cockpit…</main></div>
  if (local && director) return <FirstRun onDone={() => { setDirector(false); void projects.refresh(); cockpit.refresh() }} onCreated={(meta) => {
    void projects.open(meta.projectPath)
    cockpit.refresh()
    cockpit.select(meta.id)
    setDirector(false)
  }} />

  // The selector sits under the conversation list title; Files and Processes say which workspace they show.
  const workspaceSlot = !phone && projects.active?.projectId ? (
    <WorkspaceSelector project={projects.active} workspaces={workspaces} threads={projectThreads}
      onSelect={workspaces.select} onError={cockpit.reportError} onShowFiles={() => { workspaces.select(undefined); setSection('files') }} />
  ) : undefined
  const workspaceLabel = workspaces.hasWorktrees ? selection.label : undefined
  // Files and Processes show one checkout, so they carry the picker too once there is more than one.
  const panelPicker = workspaces.hasWorktrees || selection.kind !== 'primary' ? workspaceSlot : undefined
  const workspaceFor = (meta?: ThreadMeta): ThreadWorkspace | undefined => {
    const project = projects.active
    if (phone || !project) return undefined
    const explicit = workspaces.hasWorktrees || Object.keys(meta?.bindings ?? {}).length > 0
    const target = sendTarget(selection, workspaces.hasWorktrees, meta)
    const currentId = meta ? currentWorkspaceOf(meta, primaryId) : selection.id
    const currentLabel = meta ? labelOf(workspaces.list, project, currentId) : selection.label
    // Mid-sentence the main checkout is "the main checkout", as in the transcript note.
    const inWords = (label: string): string => (label === MAIN_CHECKOUT ? 'the main checkout' : label)
    const moves = meta && target.ok && explicit && currentId && selection.id && currentId !== selection.id ? { to: inWords(selection.label), from: inWords(currentLabel) } : undefined
    return { scope: selection.scope, folder: selection.folder, target, currentLabel, showLabel: explicit, ...(moves ? { moves } : {}),
      ...(selection.id ? { selectedId: selection.id } : {}), nameOf: (id: string) => labelOf(workspaces.list, project, id) }
  }
  const workspaceGone = (title: string): React.ReactNode => (
    <main className="workflow-empty" role="status">
      <h1>{title}</h1>
      {panelPicker ? <div className="panel-workspace">{panelPicker}</div> : null}
      <p>{selection.kind === 'loading' ? 'Loading workspaces…' : `${selection.label.replace(/ \(missing\)$/, '')} no longer exists. Nothing is shown from another checkout in its place.`}</p>
      {selection.kind === 'missing' ? <button type="button" className="button-soft" onClick={() => workspaces.select(undefined)}>Use the main checkout</button> : null}
    </main>
  )

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
        working={visible.filter((t) => isWorking(t.status)).length}
        appearance={<AppearanceMenu theme={theme.mode} onTheme={theme.set} appearance={appearance} onChange={updateAppearance} />}
        conversationsOnly={phone}
        listDropdown={hideList ? { open: listOpen, onToggle: () => (listOpen ? closeList() : setListOpen(true)), selectedTitle: cockpit.detail?.meta.title, needs: visible.filter(needsYou).length } : undefined}
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
      <div className={`workspace${(local && activePreviewUrl && !inAppBrowser) || browserOpen ? ' has-preview' : ''}`}>
        <div className="workspace-main">
      {section === 'conversations' ? (
        <div className={`layout${selectedId ? ' has-selection' : ''}${hideList ? ' list-hidden' : ''}`} style={{ '--list-width': `${listDraft ?? listWidth.width}px` } as CSSProperties}>
          {phone || hideList ? null : <ListResize width={listWidth.width} onDraft={setListDraft} onResize={listWidth.setWidth} />}
          {hideList ? null : (
            <ConversationList key={`list:${phone ? 'phone' : activePath ?? ''}`} threads={visible} selectedId={selectedId} onSelect={cockpit.select} rowShows={appearance.rows}
              workspaceSlot={workspaceSlot} {...(phone ? { projectName, canCreate: false } : {})} />
          )}
          {hideList && listOpen ? (
            <div className="list-dropdown" role="dialog" aria-label="Conversations list"
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeList() } }}>
              <div className="list-dropdown-actions">
                <button type="button" className="button-soft" onClick={() => setHidden(false)}>Keep list open</button>
              </div>
              <ConversationList key={`list-drop:${activePath ?? ''}`} threads={visible} selectedId={selectedId} rowShows={appearance.rows} workspaceSlot={workspaceSlot}
                onSelect={(id) => { cockpit.select(id); setListOpen(false) }} />
            </div>
          ) : null}
          {selectedId ? cockpit.detail?.meta.id === selectedId ? (
            <ThreadView
              initialDraft={fileDraft?.threadId === selectedId ? fileDraft?.text : undefined}
              onDraftLoaded={clearFileDraft}
              onBrowseFiles={() => setSection('files')}
              detail={cockpit.detail}
              streaming={cockpit.streaming}
              streams={cockpit.streams}
              processes={cockpit.processes.filter((p) => p.projectPath === cockpit.detail?.meta.projectPath)}
              onError={cockpit.reportError}
              instructionsRevision={detailProject?.instructions ? detailProject.instructionsRevision : undefined}
              phone={phone}
              onBack={() => cockpit.select(undefined)}
              onToggleList={() => setHidden(!hideList)}
              listHidden={hideList}
              onOpenFile={openFileFromReply}
              workspace={workspaceFor(cockpit.detail.meta)}
            />
          ) : (
            <main className="thread" role="status">Loading conversation…</main>
          ) : phone ? (
            <main className="thread thread-pick">Pick a conversation to follow it here.</main>
          ) : (
            <NewConversation
              key={`new:${activePath ?? ''}${selection.scope ? `@${selection.scope}` : ''}`}
              project={projects.active}
              workspace={workspaceFor()}
              initialDraft={fileDraft && !fileDraft.threadId && fileDraft.projectPath === activePath ? fileDraft.text : undefined}
              onDraftLoaded={clearFileDraft}
              onBrowseFiles={() => setSection('files')}
              onOpenProject={projects.open}
              onOpenGallery={openGallery}
              onOpenWorkflows={() => setSection('workflows')}
              onToggleList={() => setHidden(!hideList)}
              listHidden={hideList}
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
        !isUsable(selection) ? workspaceGone('Files') : <Files key={`${activePath ?? 'no-project'}${selection.scope ? `@${selection.scope}` : ''}`} project={projects.active} reveal={reveal}
          workspace={{ ...(selection.scope ? { scope: selection.scope } : {}), folder: selection.folder }} workspaceLabel={workspaceLabel} guard={workspaces.guard} workspacePicker={panelPicker}
          onPins={(pins) => { if (projects.active) void projects.setPinnedFiles(projects.active, pins) }} onAttach={(reference) => {
          if (!activePath) return
          setFileDraft({ projectPath: activePath, text: reference, threadId: selectedId })
          setSection('conversations')
        }} />
      ) : section === 'memory' ? (
        <Memory key={activePath ?? 'no-project'} project={projects.active} threads={cockpit.threads} onError={cockpit.reportError}
          onOpenThread={(id) => { cockpit.select(id); setSection('conversations') }} />
      ) : section === 'processes' ? (
        !isUsable(selection) ? workspaceGone('Processes') : <Processes key={`${activePath ?? 'no-project'}${selection.scope ? `@${selection.scope}` : ''}`} project={projects.active}
          workspace={{ id: selection.id, folder: selection.folder, scope: selection.scope, ...(workspaceLabel ? { label: workspaceLabel } : {}), ...(workspaces.hasWorktrees && selection.id ? { clearId: selection.id } : {}) }}
          processes={cockpit.processes} onError={cockpit.reportError} onOpenSite={openProcessSite} workspacePicker={panelPicker} />
      ) : (
        <Workflows key={activePath ?? 'no-project'} project={projects.active} onError={cockpit.reportError} initialGallery={galleryFirst}
          onOpenThread={(id) => { cockpit.refresh(); cockpit.select(id); setSection('conversations') }} />
      )}
        </div>
        {browserOpen && activeLayout && activePageKey && previewTarget ? (
          <BrowserPane key={activePageKey} pageKey={activePageKey} projectPath={previewTarget.cwd ?? previewTarget.projectPath} layout={activeLayout} openNonce={openNonce}
            onLayout={changeLayout} onClose={() => changeLayout({ visible: false })} />
        ) : null}
        {!inAppBrowser && local && activePreviewUrl && previewTarget ? <PreviewPane url={activePreviewUrl}
          onClose={() => setPreviews((current) => forgetPreview(current, previewTarget))} /> : null}
      </div>
      </ReplyContext.Provider>
    </div>
  )
}
