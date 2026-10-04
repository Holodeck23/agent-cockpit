import { RecoveryCard } from './RecoveryCard.tsx'
import { useEffect, useState, type FormEvent } from 'react'
import { api, type Project, type ThreadMeta, type MessageImage, type Workflow } from '../api.ts'
import { displayTitle } from '../workflow-list.ts'
import { native } from '../native.ts'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { Composer } from './Composer.tsx'
import { FolderIcon, PlusIcon, WorkflowIcon } from './icons.tsx'
import { StartArt } from './illustrations.tsx'

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

export function NewConversation({ onBrowseFiles, initialDraft, onDraftLoaded, project, onOpenProject, onCreated, onError, onOpenGallery, onOpenWorkflows }: NewConversationProps) {
  const [choice, setChoice] = useState<AgentChoice>(() => loadChoice(project?.path))
  const [starting, setStarting] = useState(false)
  // Starters fill the composer rather than sending: a stray click (e.g. passing
  // through from the native folder picker) must never start an agent run.
  const [prefill, setPrefill] = useState<{ text: string; reference?: boolean }>()
  // Unknown until loaded; a failed check just leaves the cards and the pointer out.
  const [workflows, setWorkflows] = useState<Workflow[]>()
  const noWorkflows = workflows?.length === 0
  const [fresh, setFresh] = useState(Boolean(initialDraft))
  const projectPath = project?.path
  useEffect(() => {
    if (!projectPath) return
    let live = true
    api.listWorkflows(projectPath).then((rows) => { if (live) setWorkflows(rows) }, () => undefined)
    return () => { live = false }
  }, [projectPath])

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
    setStarting(true)
    try {
      onCreated(await api.createThread({ projectPath: project.path, text, settings: settingsFromChoice(choice), ...(images.length ? { images } : {}) }))
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="thread new-conversation">
      <header className="thread-head">
        <div className="thread-heading">
          <h1>New conversation</h1>
        </div>
      </header>
      <div className="events">
        <div className="start">
          {project && !fresh ? <RecoveryCard projectPath={project.path} onCreated={onCreated} onFresh={() => setFresh(true)} /> : <>
          <StartArt className="start-art" />
          <h2>What are you working on?</h2>
          {project ? (
            <>
              <p>
                Say it in plain words. Your agent works in <strong title={project.path}>{project.name}</strong>.
              </p>
              {workflows && workflows.length > 0 ? (
                <section className="workflow-cards" aria-label="Start with a workflow">
                  <h3>Start with a workflow</h3>
                  <div className="workflow-card-grid">
                    {workflows.slice(0, WORKFLOW_CARDS).map((w) => (
                      // Like the starters, a card fills the message box; nothing runs until you send.
                      <button key={w.id} type="button" className="workflow-card" disabled={starting} title={`Add @workflow:${w.name} to the message`}
                        onClick={() => setPrefill({ text: `@workflow:${w.name}`, reference: true })}>
                        <WorkflowIcon />
                        <span className="workflow-card-text"><strong>{displayTitle(w)}</strong><span>{firstLine(w.prompt)}</span></span>
                      </button>
                    ))}
                  </div>
                  {onOpenWorkflows ? <button type="button" className="link-button" onClick={onOpenWorkflows}>
                    {workflows.length > WORKFLOW_CARDS ? `All ${workflows.length} workflows →` : 'Browse workflows →'}</button> : null}
                </section>
              ) : null}
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" className="suggestion" disabled={starting} title="Put this in the message box" onClick={() => setPrefill({ text: suggestion })}>
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
            </>
          ) : (
            <>
              <p>Pick the folder your agent should work in.</p>
              <OpenProject onOpenProject={onOpenProject} />
            </>
          )}
          </>}
        </div>
      </div>
      <Composer
        onBrowseFiles={onBrowseFiles}
        initialDraft={initialDraft}
        onDraftLoaded={onDraftLoaded}
        prefill={prefill}
        projectPath={project?.path}
        draftKey={`new:${project?.path ?? ''}`}
        placeholder="Describe what you want…"
        disabled={!project || starting}
        onSubmit={start}
        picker={<AgentPicker value={choice} onChange={changeChoice} />}
      />
    </main>
  )
}
