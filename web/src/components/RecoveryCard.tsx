import { useEffect, useRef, useState } from 'react'
import { api, type RecoveryView, type ThreadMeta } from '../api.ts'
import type { AgentId } from '../../../server/agents/types.ts'
import { agentName } from '../transcript.ts'

/** Current disk state belongs to the project, not to an earlier agent's claimed changes. */
export function RecoveryCard({ projectPath, onCreated, onFresh }: {
  projectPath: string; onCreated: (meta: ThreadMeta) => void; onFresh: () => void
}) {
  const [view, setView] = useState<RecoveryView>()
  const [key, setKey] = useState('')
  const [agent, setAgent] = useState<AgentId>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const inFlight = useRef(false)
  useEffect(() => {
    let live = true
    setView(undefined); setError(undefined)
    api.recentWork(projectPath).then((next) => {
      if (!live) return
      setView(next)
      const first = next.choices.find((c) => !c.busy) ?? next.choices[0]
      setKey(first?.key ?? '')
      setAgent(first && next.agents.includes(first.agent) ? first.agent : next.agents[0])
    }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [projectPath, revision])
  const choice = view?.choices.find((c) => c.key === key)
  const act = async (resume: boolean) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(undefined)
    try {
      const meta = resume && view && choice && agent && agent !== 'antigravity'
        ? await api.resumeWork({ projectPath, offerId: view.offerId, key: choice.key, agent })
        : await api.startDirector({ kind: 'project', projectPath })
      onCreated(meta)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <section className="recovery-card" aria-label="Recent work" aria-busy={busy || (!view && !error)}>
    <span className="first-run-kicker">Recent work</span>
    {!view && !error ? <p role="status">Finding recent conversations and changes…</p> : null}
    {view ? <>
      {choice ? <>
        <h3>{choice.title}</h3>
        <p className="recovery-task">{choice.task}</p>
        <p className="recovery-meta">{agentName(choice.agent)} · <time dateTime={choice.updatedAt}>{new Date(choice.updatedAt).toLocaleString()}</time> · {choice.threadId ? 'In Cockpit' : 'From your CLI'}</p>
      </> : <p>No recent unfinished conversations found. Explore the files and changes to find a useful next step.</p>}
      {view.git ? <div className="recovery-git">
        <p>{view.git.repo ? <>Current branch: <strong>{view.git.branch ?? (view.git.head ? `Detached at ${view.git.head}` : 'No commits yet')}</strong> · {view.git.changeCount} changed {view.git.changeCount === 1 ? 'file' : 'files'}</> : 'This folder is not a Git repository.'}</p>
        {view.git.changes.length ? <details><summary>Changed files now</summary><ul>{view.git.changes.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{view.git.changeCount > view.git.changes.length ? <small>Showing {view.git.changes.length} of {view.git.changeCount} changes.</small> : null}</details> : null}
      </div> : null}
      {view.warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}
      {choice ? <>
        {view.choices.length > 1 ? <label>Conversation<select aria-label="Recent conversation" disabled={busy} value={key} onChange={(e) => {
          setKey(e.target.value)
          const next = view.choices.find((c) => c.key === e.target.value)
          setAgent(next && view.agents.includes(next.agent) ? next.agent : view.agents[0])
        }}>{view.choices.map((c) => <option value={c.key} key={c.key}>{agentName(c.agent)} · {c.title}{c.busy ? ' (working)' : ''}</option>)}</select></label> : null}
        {view.agents.length ? <label>Continue with<select aria-label="Recovery agent" value={agent ?? ''} disabled={busy} onChange={(e) => setAgent(e.target.value as AgentId)}>{view.agents.map((id) => <option value={id} key={id}>{agentName(id)}</option>)}</select></label> : <p>Install and sign in to Claude Code, Codex or OpenCode to resume with preview controls.</p>}
        {agent && agent !== choice.agent ? <small>The transcript will be handed to a new {agentName(agent)} session.</small> : null}
        <small>Default model, manual permissions. Checks the current files, then opens and inspects the app.</small>
        {choice.busy ? <p role="status">This conversation is already working or waiting for input. Open it from the conversation list.</p> : null}
        <button type="button" className="button-primary" disabled={busy || !agent || choice.busy} onClick={() => void act(true)}>{busy ? 'Resuming…' : 'Resume and show me the app'}</button>
      </> : <button type="button" className="button-primary" disabled={busy} onClick={() => void act(false)}>Explore this project</button>}
    </> : null}
    {error ? <p className="first-run-error" role="alert">{error}</p> : null}
    <div className="recovery-actions">
      <button type="button" className="button-plain" disabled={busy} onClick={onFresh}>Start fresh</button>
      <button type="button" className="button-plain" disabled={busy || (!view && !error)} onClick={() => setRevision((r) => r + 1)}>Refresh recent work</button>
    </div>
  </section>
}
