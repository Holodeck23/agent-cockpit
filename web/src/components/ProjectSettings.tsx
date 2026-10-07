import { api } from '../api.ts'
import type { SettingsPatch } from '../useProjects.ts'
import { useEffect, useRef, useState } from 'react'
import type { Project } from '../api.ts'
import { native } from '../native.ts'
import { isActiveWorktree } from '../workspaces.ts'
import { avatarDataUrl } from '../project-image.ts'
import { AntigravityTools } from './AntigravityTools.tsx'
import { AccountChoice } from './AccountChoice.tsx'
import { agentName } from '../transcript.ts'
import { ProjectAvatar } from './ProjectAvatar.tsx'

// Name, tab tint, picture, instructions and the folder, for one project.
// The instructions limit matches the server's (MAX_INSTRUCTIONS_CHARS in server/projects/store.ts).
const MAX_CHARS = 8000
const TINTS: ReadonlyArray<{ id: Project['color']; label: string }> = [
  { id: 'blue', label: 'Blue' }, { id: 'pink', label: 'Pink' }, { id: 'orange', label: 'Orange' },
  { id: 'green', label: 'Green' }, { id: 'purple', label: 'Purple' }, { id: 'gray', label: 'Gray' },
]

interface ProjectSettingsProps {
  project: Project
  onSave: (patch: SettingsPatch) => Promise<Project>
  onImage: (image: string | null) => Promise<unknown>
  /** Resolves to how many schedules were paused. */
  onRemove: () => Promise<number>
  onClose: () => void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function ProjectSettings({ project, onSave, onImage, onRemove, onClose }: ProjectSettingsProps) {
  const [name, setName] = useState(project.name)
  const [color, setColor] = useState(project.color)
  const [text, setText] = useState(project.instructions ?? '')
  const [agentWorkflows, setAgentWorkflows] = useState(project.agentWorkflows === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const nameBox = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const changed = name.trim() !== project.name || color !== project.color || text.trim() !== (project.instructions ?? '') || agentWorkflows !== (project.agentWorkflows === true)

  useEffect(() => nameBox.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = (action: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true)
    setError(undefined)
    action().then(() => after?.(), (e: unknown) => setError(message(e))).finally(() => setBusy(false))
  }
  const save = (): void => run(() => onSave({ name: name.trim(), color, instructions: text, agentWorkflows }), () => setSaved(true))
  const pick = (file: File | undefined): void => {
    if (file) run(async () => onImage(await avatarDataUrl(file)))
    if (filePicker.current) filePicker.current.value = ''
  }
  const remove = (): void => run(onRemove, onClose)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal project-settings" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
        <header className="modal-head">
          <div className="project-settings-title">
            <ProjectAvatar project={{ ...project, name: name || project.name, color }} solid large />
            <h2 id="project-settings-title">{project.name}</h2>
          </div>
          <button type="button" className="activity-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="project-settings-scroll">
        <fieldset className="project-settings-body" disabled={busy}>
          <label className="field">
            Name
            <input ref={nameBox} aria-label="Project name" maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }} />
          </label>
          <div className="field">
            <span id="tint-label">Tab tint</span>
            <div className="tint-swatches" role="radiogroup" aria-labelledby="tint-label">
              {TINTS.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={color === t.id} aria-label={t.label} title={t.label}
                  className={`tint-swatch avatar-${t.id}`} onClick={() => { setColor(t.id); setSaved(false) }} />
              ))}
            </div>
          </div>
          <div className="field">
            <span>Picture</span>
            <div className="project-picture">
              <input ref={filePicker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Choose a picture"
                className="visually-hidden" onChange={(e) => pick(e.target.files?.[0])} />
              <button type="button" className="button-soft" onClick={() => filePicker.current?.click()}>{project.image ? 'Change picture…' : 'Choose picture…'}</button>
              {project.image ? <button type="button" className="button-soft" onClick={() => run(() => onImage(null))}>Remove picture</button> : null}
              <small>Shown instead of the letter. Kept by Cockpit, not in the project folder.</small>
            </div>
          </div>
          <label className="field modal-field">
            Project instructions
            <textarea value={text} maxLength={MAX_CHARS} rows={7}
              placeholder="For example: Use pnpm, not npm. Run the tests before saying a change is done."
              onChange={(e) => { setText(e.target.value); setSaved(false) }} />
          </label>
          <p className="modal-note">
            Added to every agent session in this folder, alongside the repository&apos;s own instruction files, which Cockpit
            never edits. They apply when an agent next starts, and never change permissions.
          </p>
          <label className="field-check">
            <input type="checkbox" checked={agentWorkflows} onChange={(e) => { setAgentWorkflows(e.target.checked); setSaved(false) }} />
            <span>
              <strong>Let agents manage workflows</strong>
              Agents may save, update and schedule this project&apos;s workflows without asking each time. Off, they can only add new
              workflows with the schedule off, after you approve. Applies when an agent next starts.
            </span>
          </label>
          <AntigravityTools project={project} />
          <ProjectAccounts projectPath={project.path} />
          <DocumentsFolder projectPath={project.path} />
          {native?.browser ? <WebsiteData projectPath={project.path} projectId={project.projectId} projectName={project.name} /> : null}
          <div className="field">
            <span>Folder</span>
            <div className="project-folder">
              <p className="modal-path" title={project.path}>{project.path}</p>
              {native ? <button type="button" className="button-soft" onClick={() => native?.openFolder(project.path)}>Open in Finder</button> : null}
            </div>
          </div>
        </fieldset>
        </div>
        {error ? <p className="modal-error" role="alert">{error}</p> : null}
        {confirmRemove ? (
          <div className="remove-confirm" role="alertdialog" aria-labelledby="remove-title" aria-describedby="remove-detail">
            <strong id="remove-title">Remove {project.name} from Cockpit?</strong>
            <p id="remove-detail">The folder and its files are not touched. Its conversations stay saved and come back if you open the folder again. Any schedules in it are paused.</p>
            <div className="modal-foot">
              <span className="modal-count" />
              <button type="button" className="button-soft" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
              <button type="button" className="button-danger" disabled={busy} onClick={remove}>Remove from Cockpit</button>
            </div>
          </div>
        ) : (
          <footer className="modal-foot">
            <button type="button" className="button-quiet-danger" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove from Cockpit…</button>
            <span className="modal-count">
              {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              {project.instructionsRevision ? ` · revision ${project.instructionsRevision}` : ''}
              {saved && !changed ? ' · saved' : ''}
            </span>
            <button type="button" className="button-soft" onClick={onClose}>Done</button>
            <button type="button" className="button-primary" disabled={!changed || !name.trim() || busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}

/**
 * The in-app browser's website data for this project (W9.2): logins and storage of the sites
 * opened in its conversations. Separate from agent sign-ins, which this never touches.
 */
function WebsiteData({ projectPath, projectId, projectName }: { projectPath: string; projectId?: string; projectName: string }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // A worktree's pages keep their data with its folder: clearing the project's data clears theirs too.
  const [worktrees, setWorktrees] = useState<readonly string[]>([])
  useEffect(() => {
    if (!projectId) return
    let live = true
    api.workspaces(projectId).then((answer) => { if (live) setWorktrees(answer.workspaces.filter(isActiveWorktree).map((w) => w.cwd)) }, () => undefined)
    return () => { live = false }
  }, [projectId])
  const clear = (): void => {
    setBusy(true)
    const browser = native?.browser
    void Promise.all([projectPath, ...worktrees].map((folder) => browser?.clearData(folder)))
      .then((errors) => {
        const error = errors.find((e) => e)
        setNote(error ?? `Cleared website data for ${projectName}${worktrees.length ? ` and ${worktrees.length === 1 ? 'its worktree' : `its ${worktrees.length} worktrees`}` : ''}.`)
      })
      .finally(() => setBusy(false))
  }
  return (
    <div className="field">
      <span>Website data</span>
      <div className="project-folder">
        <p className="modal-note">Logins and storage of sites opened in this project&apos;s browser. Agent sign-ins are separate and stay as they are.</p>
        <button type="button" className="button-soft" disabled={busy} onClick={clear}>Clear website data</button>
      </div>
      {note ? <p className="modal-note" role="status">{note}</p> : null}
    </div>
  )
}

/** Where "Your documents" live for this project (F14). Changing it copies them over at once. */
function DocumentsFolder({ projectPath }: { projectPath: string }) {
  const [where, setWhere] = useState<{ folder: string; custom: boolean }>()
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { api.documentsFolder(projectPath).then(setWhere, (e: unknown) => setError(message(e))) }, [projectPath])
  const move = (folder: string | null): void => {
    setError('')
    api.setDocumentsFolder(projectPath, folder).then((result) => {
      setWhere({ folder: result.folder, custom: folder !== null })
      const n = result.copied.length
      setNote(`${n ? `Copied ${n} ${n === 1 ? 'document' : 'documents'} there.` : 'Nothing needed copying.'} The previous folder was left as it was.`)
    }, (e: unknown) => setError(message(e)))
  }
  return (
    <div className="field">
      <span>Your documents folder</span>
      <div className="project-folder">
        <p className="modal-path" title={where?.folder}>{where ? (where.custom ? where.folder : 'Kept by Cockpit, outside this project') : '…'}</p>
        {native ? <button type="button" className="button-soft" onClick={() => { void native?.pickFolder().then((picked) => { if (picked) move(picked) }) }}>Choose folder…</button> : null}
        {where?.custom ? <button type="button" className="button-soft" onClick={() => move(null)}>Use Cockpit&apos;s folder</button> : null}
      </div>
      {note ? <small role="status">{note}</small> : null}
      {error ? <small role="alert" className="field-error">{error}</small> : null}
    </div>
  )
}

/**
 * Which account each agent uses in this project (W12.1): the same choice the agent picker shows.
 * It applies at once, unlike the fields that wait for Save.
 */
function ProjectAccounts({ projectPath }: { projectPath: string }) {
  return (
    <div className="field project-accounts">
      <span>Accounts</span>
      {(['claude', 'codex', 'antigravity', 'opencode'] as const).map((agent) => (
        <div key={agent} className="project-account" role="group" aria-label={`${agentName(agent)} account`}>
          <strong>{agentName(agent)}</strong>
          <AccountChoice agent={agent} projectPath={projectPath} recheck={agent === 'claude'} />
        </div>
      ))}
    </div>
  )
}
