import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Project, type Workflow, type WorkflowInput } from '../api.ts'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { WorkflowIcon, PlusIcon } from './icons.tsx'

interface Props {
  project: Project | undefined
  onError: (message: string) => void
  onOpenThread: (id: string) => void
}
type Intent = 'save' | 'run' | 'schedule'
const when = (value?: string | null) => value ? new Date(value).toLocaleString() : '—'

export function Workflows({ project, onError, onOpenThread }: Props) {
  const [rows, setRows] = useState<Workflow[]>([])
  const [selected, setSelected] = useState<string>()
  const [creating, setCreating] = useState(false)
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
  if (!project) return <main className="workflow-empty"><WorkflowIcon /><h1>Workflows</h1><p>Open a project to save repeatable jobs.</p></main>
  return <div className="workflows-layout">
    <nav className="workflow-list" aria-label="Saved workflows">
      <header><div><span className="workflow-kicker">{project.name}</span><h1>Workflows</h1></div>
        <button type="button" className="new-button" aria-label="New workflow" disabled={busy}
          onClick={() => { setSelected(undefined); setCreating(true) }}><PlusIcon /></button></header>
      <p className="workflow-intro">Save a job once. Run it when you need it.</p>
      {!loaded ? <p role="status">Loading workflows…</p> : rows.length === 0 ? <div className="workflow-list-empty"><WorkflowIcon /><strong>No workflows yet</strong><span>Start with a review, a daily check, or a project brief.</span></div> : null}
      {rows.map((w) => <button type="button" key={w.id} className={`workflow-row ${selected === w.id ? 'selected' : ''}`}
        aria-current={selected === w.id ? 'true' : undefined} disabled={busy} onClick={() => { setSelected(w.id); setCreating(false) }}>
        <strong>{w.name}</strong><span>{w.prompt.slice(0, 100)}</span>
        <small className={w.lastError ? 'workflow-error' : ''}>{w.lastError ? 'Needs attention' : w.enabled ? `Every ${w.intervalMinutes} min` : 'Manual / paused'}</small>
      </button>)}
      <footer>Schedules run while Cockpit is open. Missed runs resume once, without a backlog.</footer>
    </nav>
    {creating || current ? <WorkflowEditor key={current?.id ?? 'new'} workflow={current} projectPath={project.path} busy={busy} onSave={save}
      onPause={() => perform(async () => { if (current) await api.enableWorkflow(current.id, false); await refresh() })}
      onArchive={() => perform(async () => { if (current) await api.archiveWorkflow(current.id); setSelected(undefined); await refresh() })}
      onOpenThread={onOpenThread} /> : <main className="workflow-empty"><WorkflowIcon /><h2>Make the repeatable work easy.</h2>
        <p>Choose a workflow to edit its instructions, run it, or set a schedule. Each run opens a conversation with your agent.</p>
        <button type="button" className="button-primary" onClick={() => setCreating(true)}>Create a workflow</button></main>}
  </div>
}

function WorkflowEditor({ workflow, projectPath, busy, onSave, onPause, onArchive, onOpenThread }: {
  workflow?: Workflow; projectPath: string; busy: boolean
  onSave: (input: WorkflowInput, intent: Intent) => Promise<void>
  onPause: () => Promise<void>; onArchive: () => Promise<void>; onOpenThread: (id: string) => void
}) {
  const [name, setName] = useState(workflow?.name ?? '')
  const [prompt, setPrompt] = useState(workflow?.prompt ?? '')
  const [interval, setInterval] = useState(workflow?.intervalMinutes?.toString() ?? '')
  const [choice, setChoice] = useState<AgentChoice>({ agent: workflow?.settings.agent ?? 'claude', model: workflow?.settings.model ?? '',
    effort: workflow?.settings.effort ?? '', permissionMode: workflow?.settings.permissionMode ?? 'manual' })
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const intent = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value as Intent | undefined
    void onSave({ name, prompt, projectPath, intervalMinutes: interval ? Number(interval) : null,
      settings: settingsFromChoice(choice, workflow?.settings) }, intent ?? 'save')
  }
  return <main className="workflow-editor">
    <header><span className="workflow-kicker">Reusable instructions</span><h1>{workflow ? workflow.name : 'New workflow'}</h1>
      <p>{workflow?.enabled ? `Scheduled · Next run ${when(workflow.nextRunAt)}` : 'Run manually, or turn on a schedule when you’re ready.'}</p></header>
    {workflow?.lastError ? <div className="workflow-notice" role="alert"><strong>Schedule paused</strong><p>{workflow.lastError}</p></div> : null}
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>Workflow name<input required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={name} onChange={(e) => setName(e.target.value)} placeholder="daily-review" /></label>
      <small>Lowercase words with hyphens. Mention it as <code>@workflow:{name || 'daily-review'}</code>.</small>
      <label>Instructions<textarea required maxLength={40_000} rows={9} value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder="Review this project’s recent changes. Report bugs with file locations and suggested fixes." /></label>
      <small>Include another workflow with <code>@workflow:name</code>. Its instructions join this run; it does not launch another agent.</small>
      <div className="workflow-config"><div><span className="workflow-label">Agent and permissions</span><AgentPicker value={choice} onChange={setChoice} /></div>
        <label>Repeat every (minutes)<input type="number" min={5} max={43200} step={1} value={interval} onChange={(e) => setInterval(e.target.value)} placeholder="Manual only" /></label></div>
      <p className="workflow-help">Saving pauses an existing schedule. Scheduled runs use these permissions and appear in Conversations. A failure pauses the schedule; a busy run skips the next occurrence.</p>
      <div className="workflow-actions">
        <button type="submit" className="button-primary" value="save">{busy ? 'Working…' : 'Save workflow'}</button>
        <button type="submit" value="run">Save and run</button>
        <button type="submit" value="schedule" disabled={!interval}>Save and enable schedule</button>
      </div>
    </fieldset></form>
    {workflow ? <footer className="workflow-run"><div><strong>Latest run</strong><span>{when(workflow.lastRunAt)}</span>
      {workflow.lastThreadId ? <button type="button" onClick={() => onOpenThread(workflow.lastThreadId!)}>Open conversation →</button> : <span>No runs yet</span>}</div>
      <div className="workflow-actions">{workflow.enabled ? <button type="button" disabled={busy} onClick={() => void onPause()}>Pause schedule</button> : null}
        <button type="button" disabled={busy} onClick={() => void onArchive()}>Archive workflow</button></div></footer> : null}
  </main>
}
