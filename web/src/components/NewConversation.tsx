import { RecoveryCard } from './RecoveryCard.tsx'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Project, type ThreadMeta, type MessageImage, type Workflow, type WorkflowInput } from '../api.ts'
import { displayTitle } from '../workflow-list.ts'
import { native } from '../native.ts'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { Composer } from './Composer.tsx'
import { WorkflowEditor } from './Workflows.tsx'
import { FolderIcon, PlusIcon, SidebarIcon, WorkflowIcon } from './icons.tsx'
import { StartArt } from './illustrations.tsx'
import { MAIN_CHECKOUT, type ThreadWorkspace } from '../workspaces.ts'

interface NewConversationProps {
  onBrowseFiles?: () => void
  initialDraft?: string
  onDraftLoaded?: () => void
  project: Project | undefined
  onOpenProject: (path: string) => Promise<void>
  onCreated: (meta: ThreadMeta) => void
  onError: (message: string) => void
  /** Shown while the project has no workflows yet. */
  onOpenGallery?: () => void
  /** The project's workflow list. */
  onOpenWorkflows?: () => void
  onToggleList?: () => void
  listHidden?: boolean
  /** The selected workspace: where the conversation starts. */
  workspace?: ThreadWorkspace
}

/** Workflow cards shown above the message box; the rest are a click away. */
const WORKFLOW_CARDS = 4

// Last choice per project, falling back to the last choice anywhere. A default for new
// conversations only: it never changes an existing conversation's settings.
const CHOICE_KEY = 'cockpit:last-agent'
const choiceKey = (projectPath: string | undefined): string => (projectPath ? `${CHOICE_KEY}:${projectPath}` : CHOICE_KEY)
const SUGGESTIONS = [
  'Explain how this project is put together',
  'Find one bug and fix it, with a test',
  'Tidy up the README so a newcomer can get started',
]

/** A workflow's first line of instructions, as the card's second line. */
const firstLine = (prompt: string): string => prompt.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''

function loadChoice(projectPath: string | undefined): AgentChoice {
  const fallback: AgentChoice = { agent: 'claude', model: '', effort: '', permissionMode: 'manual' }
  try {
    const raw = localStorage.getItem(choiceKey(projectPath)) ?? localStorage.getItem(CHOICE_KEY)
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<AgentChoice>) } : fallback
  } catch {
    return fallback
  }
}

function OpenProject({ onOpenProject }: { onOpenProject: (path: string) => Promise<void> }) {
  const [path, setPath] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (path.trim()) void onOpenProject(path.trim())
  }
  return native ? (
    <button
      type="button"
      className="button-primary open-project"
      onClick={() => {
        void native?.pickFolder().then((picked) => (picked ? onOpenProject(picked) : undefined))
      }}
    >
      <FolderIcon />
      Open a project folder…
    </button>
  ) : (
    <form className="open-project-form" onSubmit={submit}>
      <input aria-label="Project folder" placeholder="/path/to/project" value={path} onChange={(e) => setPath(e.target.value)} />
      <button type="submit" className="button-primary">
        Open
      </button>
    </form>
  )
}

export function NewConversation({ onBrowseFiles, initialDraft, onDraftLoaded, project, onOpenProject, onCreated, onError, onOpenGallery, onOpenWorkflows, onToggleList, listHidden = false, workspace }: NewConversationProps) {
  const [choice, setChoice] = useState<AgentChoice>(() => loadChoice(project?.path))
  const [starting, setStarting] = useState(false)
  // Starters fill the composer rather than sending: a stray click (e.g. passing
  // through from the native folder picker) must never start an agent run.
  const [prefill, setPrefill] = useState<{ text: string; reference?: boolean }>()
  // Unknown until loaded; a failed check just leaves the cards and the pointer out.
  const [workflows, setWorkflows] = useState<Workflow[]>()
  const noWorkflows = workflows?.length === 0
  const [fresh, setFresh] = useState(Boolean(initialDraft))
  // F16: the workflow editor opens here, over the start screen; the composer and its draft stay put.
  const [newWorkflow, setNewWorkflow] = useState(false)
  const [savingWorkflow, setSavingWorkflow] = useState(false)
  const screen = useRef<HTMLElement>(null)
  const projectPath = project?.path
  const loadWorkflows = useCallback(() => {
    if (!projectPath) return () => undefined
    let live = true
    api.listWorkflows(projectPath).then((rows) => { if (live) setWorkflows(rows) }, () => undefined)
    return () => { live = false }
  }, [projectPath])
  useEffect(loadWorkflows, [loadWorkflows])
  const closeWorkflowEditor = (): void => {
    setNewWorkflow(false)
    requestAnimationFrame(() => screen.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus())
  }
  const saveWorkflow = async (input: WorkflowInput): Promise<void> => {
    setSavingWorkflow(true)
    try {
      await api.saveWorkflow(input)
      loadWorkflows()
      closeWorkflowEditor()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingWorkflow(false)
    }
  }

  const changeChoice = (next: AgentChoice): void => {
    setChoice(next)
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(next))
      if (project) localStorage.setItem(choiceKey(project.path), JSON.stringify(next))
    } catch {
      // not persisted
    }
  }

  const start = async (text: string, images: readonly MessageImage[]): Promise<void> => {
    if (!project) return
    const target = workspace?.target
    if (target && !target.ok) throw new Error(target.reason)
    setStarting(true)
    try {
      onCreated(await api.createThread({ projectPath: project.path, ...(target?.workspaceId ? { workspaceId: target.workspaceId } : {}), text, settings: settingsFromChoice(choice), ...(images.length ? { images } : {}) }))
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="thread new-conversation" ref={screen}>
      <header className="thread-head">
        {onToggleList ? <button type="button" className="thread-list-toggle" aria-label={listHidden ? 'Show conversation list' : 'Hide conversation list'}
          aria-pressed={!listHidden} title={listHidden ? 'Show conversation list' : 'Hide conversation list'} onClick={onToggleList}><SidebarIcon /></button> : null}
        <div className="thread-heading">
          <h1>New conversation</h1>
          <div className="thread-breadcrumbs"><span>Conversations</span><span aria-hidden="true">›</span><span>New</span></div>
        </div>
      </header>
      {newWorkflow && project ? (
        <div className="events new-workflow">
          <WorkflowEditor projectPath={project.path} busy={savingWorkflow} saveOnly onSave={saveWorkflow} onCancel={closeWorkflowEditor} />
        </div>
      ) : <div className="events">
        <div className="start">
          {project && !fresh && !workspace?.scope ? <RecoveryCard projectPath={project.path} onCreated={onCreated} onFresh={() => setFresh(true)} /> : <>
          <StartArt className="start-art" />
          <h2>What are you working on?</h2>
          {project ? (
            <>
              <p>
                Say it in plain words. Your agent works in {!workspace?.showLabel ? <strong title={project.path}>{project.name}</strong>
                  : workspace.currentLabel === MAIN_CHECKOUT ? <>the main checkout of <strong title={workspace.folder}>{project.name}</strong></>
                  : <><strong title={workspace.folder}>{workspace.currentLabel}</strong>, a worktree of <strong>{project.name}</strong></>}.
              </p>
              {workflows && workflows.length > 0 ? (
                <section className="workflow-cards" aria-label="Start with a workflow">
                  <h3>Start with a workflow</h3>
                  <div className="workflow-card-grid">
                    {workflows.slice(0, WORKFLOW_CARDS).map((w) => (
                      // Like the starters, a card fills the message box; nothing runs until you send.
                      <button key={w.id} type="button" className={`workflow-card${prefill?.text === `@workflow:${w.name}` ? ' selected' : ''}`} disabled={starting} title={`Add @workflow:${w.name} to the message`}
                        onClick={() => setPrefill({ text: `@workflow:${w.name}`, reference: true })}>
                        <WorkflowIcon />
                        <span className="workflow-card-text"><strong>{displayTitle(w)}</strong><span>{firstLine(w.prompt)}</span></span>
                        <small className={`start-workflow-status${w.lastError ? ' error' : w.enabled ? ' scheduled' : ''}`}>
                          {w.lastError ? 'Needs attention' : w.enabled ? 'Scheduled' : w.calendar ? 'Paused' : 'Manual'}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="workflow-card-links">
                    {onOpenWorkflows ? <button type="button" className="link-button" onClick={onOpenWorkflows}>
                      {workflows.length > WORKFLOW_CARDS ? `All ${workflows.length} workflows →` : 'Browse workflows →'}</button> : null}
                    <button type="button" className="link-button" onClick={() => setNewWorkflow(true)}>+ New workflow</button>
                  </div>
                </section>
              ) : null}
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" className={`suggestion${prefill?.text === suggestion ? ' selected' : ''}`} disabled={starting} title="Put this in the message box" onClick={() => setPrefill({ text: suggestion })}>
                    <span>{suggestion}</span>
                    <span className="suggestion-go" aria-hidden>
                      <PlusIcon />
                    </span>
                  </button>
                ))}
              </div>
              {noWorkflows && onOpenGallery ? (
                <button type="button" className="gallery-pointer" onClick={onOpenGallery}>
                  <WorkflowIcon />
                  <span><strong>Doing the same job often?</strong> Copy a ready-made workflow from the gallery.</span>
                  <span className="gallery-pointer-go" aria-hidden>→</span>
                </button>
              ) : null}
              {noWorkflows ? <button type="button" className="link-button" onClick={() => setNewWorkflow(true)}>+ New workflow</button> : null}
            </>
          ) : (
            <>
              <p>Pick the folder your agent should work in.</p>
              <OpenProject onOpenProject={onOpenProject} />
            </>
          )}
          </>}
        </div>
      </div>}
      <Composer
        onBrowseFiles={onBrowseFiles}
        initialDraft={initialDraft}
        onDraftLoaded={onDraftLoaded}
        prefill={prefill}
        projectPath={project?.path}
        workspaceId={workspace?.scope}
        workspaceFolder={workspace?.folder}
        blocked={workspace?.target.ok === false ? workspace.target.reason : undefined}
        draftKey={`new:${project?.path ?? ''}${workspace?.scope ? `@${workspace.scope}` : ''}`}
        placeholder="Describe what you want…"
        disabled={!project || starting}
        onSubmit={start}
        picker={<AgentPicker value={choice} onChange={changeChoice} {...(project ? { projectPath: project.path } : {})} />}
      />
    </main>
  )
}
