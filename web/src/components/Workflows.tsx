import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Project, type Workflow, type WorkflowInput } from '../api.ts'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { SidebarIcon, WorkflowIcon } from './icons.tsx'
import { RepeatPicker } from './RepeatPicker.tsx'
import { WorkflowGallery } from './WorkflowGallery.tsx'
import { WorkflowList } from './WorkflowList.tsx'
import { WorkflowInstructions } from './WorkflowInstructions.tsx'
import { canSchedule, localZone, repeatFrom, repeatInput } from '../repeat.ts'
import { describeCalendar } from '../../../server/workflows/calendar.ts'
import { displayTitle } from '../workflow-list.ts'
import type { GalleryWorkflow } from '../gallery/catalog.ts'
import { copyInput } from '../gallery/gallery.ts'

interface Props {
  project: Project | undefined
  onError: (message: string) => void
  onOpenThread: (id: string) => void
  /** Open on the gallery, e.g. from the new-conversation screen. */
  initialGallery?: boolean
}
type Intent = 'save' | 'run' | 'schedule'
const when = (value?: string | null) => value ? new Date(value).toLocaleString() : '—'

export function Workflows({ project, onError, onOpenThread, initialGallery = false }: Props) {
  const [rows, setRows] = useState<Workflow[]>([])
  const [selected, setSelected] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [gallery, setGallery] = useState(initialGallery)
  const [listHidden, setListHidden] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const projectPath = project?.path
  const refresh = useCallback(async () => {
    if (!projectPath) return
    const all = await api.listWorkflows(projectPath)
    setRows(all); setLoaded(true)
  }, [projectPath])
  useEffect(() => {
    const load = () => { void refresh().catch((e: unknown) => onError(String(e))) }
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [refresh, onError])
  const current = rows.find((w) => w.id === selected)
  const perform = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch (e) { onError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const save = (input: WorkflowInput, intent: Intent) => perform(async () => {
    const saved = await api.saveWorkflow(input, current?.id)
    setSelected(saved.id); setCreating(false)
    await refresh()
    if (intent === 'schedule') { await api.enableWorkflow(saved.id, true); await refresh() }
    if (intent === 'run') { const thread = await api.runWorkflow(saved.id); onOpenThread(thread.id) }
  })
  const taken = new Set(rows.map((w) => w.name))
  // A gallery workflow becomes a paused copy in this project: saved, never run or scheduled here.
  const addFromGallery = (entry: GalleryWorkflow) => perform(async () => {
    if (!projectPath) return
    const saved = await api.saveWorkflow(copyInput(entry, projectPath, taken, localZone()))
    await refresh()
    setSelected(saved.id); setCreating(false); setGallery(false)
  })
  if (!project) return <main className="workflow-empty"><WorkflowIcon /><h1>Workflows</h1><p>Open a project to save repeatable jobs.</p></main>
  const listToggle = { hidden: listHidden, toggle: () => setListHidden((hidden) => !hidden) }
  return <div className={`workflows-layout${listHidden ? ' list-hidden' : ''}`}>
    <WorkflowList project={project} rows={rows} loaded={loaded} selected={selected} busy={busy} hidden={listHidden}
      galleryOpen={gallery}
      onSelect={(id) => { setSelected(id); setCreating(false); setGallery(false) }}
      onCreate={() => { setSelected(undefined); setCreating(true); setGallery(false) }}
      onOpenGallery={() => setGallery(true)} />
    {gallery ? <WorkflowGallery projectName={project.name} taken={taken} busy={busy} onAdd={(entry) => void addFromGallery(entry)}
      onClose={() => setGallery(false)} listToggle={listToggle} />
    : creating || current ? <WorkflowEditor key={current?.id ?? 'new'} workflow={current} projectPath={project.path} busy={busy} onSave={save}
      onPause={() => perform(async () => { if (current) await api.enableWorkflow(current.id, false); await refresh() })}
      onArchive={() => perform(async () => { if (current) await api.archiveWorkflow(current.id); setSelected(undefined); await refresh() })}
      onOpenThread={onOpenThread} listToggle={listToggle} /> : <main className="workflow-empty"><button type="button" className="workflow-list-toggle" aria-label={listHidden ? 'Show workflows' : 'Hide workflows'}
        aria-pressed={!listHidden} onClick={listToggle.toggle}><SidebarIcon /></button><WorkflowIcon /><h2>Make the repeatable work easy.</h2>
        <p>Choose a workflow to edit its instructions, run it, or set a schedule. Each run opens a conversation with your agent.</p>
        <div className="workflow-actions"><button type="button" className="button-primary" onClick={() => setCreating(true)}>Create a workflow</button>
          <button type="button" onClick={() => setGallery(true)}>Browse the gallery</button></div></main>}
  </div>
}

export function WorkflowEditor({ workflow, projectPath, busy, onSave, onPause, onArchive, onOpenThread, onCancel, saveOnly = false, listToggle }: {
  workflow?: Workflow; projectPath: string; busy: boolean
  onSave: (input: WorkflowInput, intent: Intent) => Promise<void>
  onPause?: () => Promise<void>; onArchive?: () => Promise<void>; onOpenThread?: (id: string) => void
  /** Shown as Cancel: leaves without saving anything. */
  onCancel?: () => void
  /** Only Save: opened from another screen, saving must not also start or schedule a run (F16). */
  saveOnly?: boolean
  listToggle?: { readonly hidden: boolean; readonly toggle: () => void }
}) {
  const [name, setName] = useState(workflow?.name ?? '')
  const [title, setTitle] = useState(workflow?.title ?? '')
  const [collection, setCollection] = useState(workflow?.collection ?? '')
  const [prompt, setPrompt] = useState(workflow?.prompt ?? '')
  const [repeat, setRepeat] = useState(() => repeatFrom(workflow))
  const [choice, setChoice] = useState<AgentChoice>({ agent: workflow?.settings.agent ?? 'claude', model: workflow?.settings.model ?? '',
    effort: workflow?.settings.effort ?? '', permissionMode: workflow?.settings.permissionMode ?? 'manual' })
  const form = useRef<HTMLFormElement>(null)
  // ⌘S in the document hands over its text; the form submits in the same tick, before the state
  // update lands, so the submit reads it from here instead of from `prompt`.
  const flushed = useRef<string | undefined>(undefined)
  const [missing, setMissing] = useState(false)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const text = flushed.current ?? prompt
    flushed.current = undefined
    // The document editor is not a form field, so the form cannot require it.
    if (!text.trim()) { setMissing(true); return }
    setMissing(false)
    const intent = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value as Intent | undefined
    void onSave({ name, title, collection, prompt: text, projectPath, ...repeatInput(repeat),
      settings: settingsFromChoice(choice, workflow?.settings) }, intent ?? 'save')
  }
  return <main className="workflow-editor">
    <header><div className="workflow-detail-heading">
      {listToggle ? <button type="button" className="workflow-list-toggle" aria-label={listToggle.hidden ? 'Show workflows' : 'Hide workflows'}
        aria-pressed={!listToggle.hidden} onClick={listToggle.toggle}><SidebarIcon /></button> : null}
      <div><span className="workflow-kicker">Reusable instructions</span><h1>{workflow ? displayTitle(workflow) : 'New workflow'}</h1>
        {listToggle ? <div className="workflow-breadcrumbs"><span>Workflows</span><span aria-hidden="true">›</span><span>{workflow ? 'Saved workflow' : 'New workflow'}</span></div> : null}
      </div></div>
      <p>{workflow?.enabled ? `Scheduled · ${workflow.calendar ? describeCalendar(workflow.calendar) : `Every ${workflow.intervalMinutes} min`} · Next run ${when(workflow.nextRunAt)}` : 'Run manually, or turn on a schedule when you’re ready.'}</p></header>
    {workflow?.lastError ? <div className="workflow-notice" role="alert"><strong>Schedule paused</strong><p>{workflow.lastError}</p></div> : null}
    <form ref={form} onSubmit={submit}><fieldset disabled={busy}>
      <label>Title<input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Daily review" /></label>
      <label>Reference name<input required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={name} readOnly={Boolean(workflow)}
        onChange={(e) => setName(e.target.value)} placeholder="daily-review" /></label>
      <small>{workflow ? <>Fixed once saved, so every <code>@workflow:{name}</code> mention keeps working. Change the title instead.</>
        : <>Lowercase words with hyphens. Mention it as <code>@workflow:{name || 'daily-review'}</code>.</>}</small>
      <label>Collection<input maxLength={40} value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="Optional, e.g. Quality" /></label>
      <WorkflowInstructions projectPath={projectPath} value={prompt} onChange={setPrompt} autoFocus={!workflow} disabled={busy}
        onSave={(latest) => { flushed.current = latest; form.current?.requestSubmit(); flushed.current = undefined }} />
      {missing ? <p className="workflow-notice" role="alert">Write the instructions first.</p> : null}
      <small>Include another workflow with <code>@workflow:name</code>. Its instructions join this run; it does not launch another agent.</small>
      <div className="workflow-config"><div><span className="workflow-label">Agent and permissions</span><AgentPicker value={choice} onChange={setChoice} /></div>
        <RepeatPicker value={repeat} onChange={setRepeat} /></div>
      <p className="workflow-help">Saving pauses an existing schedule. Scheduled runs use these permissions and appear in Conversations. A failure pauses the schedule; a busy run skips the next occurrence.</p>
      <div className="workflow-actions">
        <button type="submit" className="button-primary" value="save">{busy ? 'Working…' : 'Save workflow'}</button>
        {saveOnly ? null : <>
          <button type="submit" value="run">Save and run</button>
          <button type="submit" value="schedule" disabled={!canSchedule(repeat)}>Save and enable schedule</button>
        </>}
        {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}
      </div>
    </fieldset></form>
    {workflow ? <footer className="workflow-run"><div><strong>Latest run</strong><span>{when(workflow.lastRunAt)}</span>
      {workflow.lastThreadId && onOpenThread ? <button type="button" onClick={() => onOpenThread(workflow.lastThreadId!)}>Open conversation →</button> : <span>No runs yet</span>}</div>
      <div className="workflow-actions">{workflow.enabled && onPause ? <button type="button" disabled={busy} onClick={() => void onPause()}>Pause schedule</button> : null}
        {onArchive ? <button type="button" disabled={busy} onClick={() => void onArchive()}>Archive workflow</button> : null}</div></footer> : null}
  </main>
}
