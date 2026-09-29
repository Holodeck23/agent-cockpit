import { useState, type FormEvent } from 'react'
import { api, type Project, type ThreadMeta } from '../api.ts'
import { native } from '../native.ts'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { Composer } from './Composer.tsx'
import { ArrowUpIcon, FolderIcon } from './icons.tsx'
import { StartArt } from './illustrations.tsx'

interface NewConversationProps {
  onBrowseFiles?: () => void
  initialDraft?: string
  onDraftLoaded?: () => void
  project: Project | undefined
  onOpenProject: (path: string) => Promise<void>
  onCreated: (meta: ThreadMeta) => void
  onError: (message: string) => void
}

const CHOICE_KEY = 'cockpit:last-agent'
const SUGGESTIONS = [
  'Explain how this project is put together',
  'Find one bug and fix it, with a test',
  'Tidy up the README so a newcomer can get started',
]

function loadChoice(): AgentChoice {
  const fallback: AgentChoice = { agent: 'claude', model: '', effort: '', permissionMode: 'manual' }
  try {
    const raw = localStorage.getItem(CHOICE_KEY)
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

export function NewConversation({ onBrowseFiles, initialDraft, onDraftLoaded, project, onOpenProject, onCreated, onError }: NewConversationProps) {
  const [choice, setChoice] = useState<AgentChoice>(loadChoice)
  const [starting, setStarting] = useState(false)

  const changeChoice = (next: AgentChoice): void => {
    setChoice(next)
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(next))
    } catch {
      // not persisted
    }
  }

  const start = async (text: string): Promise<void> => {
    if (!project) return
    setStarting(true)
    try {
      onCreated(await api.createThread({ projectPath: project.path, text, settings: settingsFromChoice(choice) }))
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
          <StartArt className="start-art" />
          <h2>What are you working on?</h2>
          {project ? (
            <>
              <p>
                Say it in plain words. Your agent works in <strong title={project.path}>{project.name}</strong>.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" className="suggestion" disabled={starting} onClick={() => void start(suggestion).catch(() => undefined)}>
                    <span>{suggestion}</span>
                    <span className="suggestion-go" aria-hidden>
                      <ArrowUpIcon />
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p>Pick the folder your agent should work in.</p>
              <OpenProject onOpenProject={onOpenProject} />
            </>
          )}
        </div>
      </div>
      <Composer
        onBrowseFiles={onBrowseFiles}
        initialDraft={initialDraft}
        onDraftLoaded={onDraftLoaded}
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
