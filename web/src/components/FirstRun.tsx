import { RecoveryCard } from './RecoveryCard.tsx'
import { useEffect, useRef, useState } from 'react'
import { api, type AgentStatus, type Project, type ThreadMeta } from '../api.ts'
import { native } from '../native.ts'
import { agentName } from '../transcript.ts'
import { FolderIcon, Mark } from './icons.tsx'

export function FirstRun({ onDone, onCreated }: { onDone: () => void; onCreated: (meta: ThreadMeta) => void }) {
  const [agents, setAgents] = useState<AgentStatus[]>()
  const [project, setProject] = useState<Project>()
  const [fresh, setFresh] = useState(false)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  useEffect(() => {
    let live = true
    api.agents().then((rows) => { if (live) setAgents(rows) }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  const installed = agents?.filter((a) => a.installation.installed)
  const agent = (['claude', 'codex', 'opencode', 'antigravity'] as const).find((id) => installed?.some((a) => a.id === id))
  const sampleReady = installed?.some((a) => a.id !== 'antigravity')

  const act = async (action: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    try { await action() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  const open = () => act(async () => {
    const picked = native ? await native.pickFolder() : path.trim()
    if (picked) { setFresh(false); setProject(await api.openProject(picked, { pinned: true })) }
  })
  const start = (kind: 'project' | 'sample') => act(async () => {
    const meta = await api.startDirector(kind === 'sample' ? { kind } : { kind, projectPath: project!.path })
    onCreated(meta)
  })

  return <div className="app first-run">
    <header className="first-run-bar"><Mark /><span>Cockpit</span>
      <button type="button" className="button-plain" disabled={busy} onClick={() => void act(async () => { await api.dismissDirector(); onDone() })}>Skip for now</button>
    </header>
    <main className="first-run-body">
      <div className="first-run-intro"><span className="first-run-kicker">A place to pick up the thread</span>
        <h1>Pick up where<br /> you left off.</h1>
        <p>Bring a project. Your agent will help you find a useful next step.</p>
      </div>
      <section className="first-run-actions" aria-label="Get started" aria-busy={busy}>
        {project ? <>
          <span className="first-run-kicker">Your project</span>
          <h2>{project.name}</h2><p className="first-run-path">{project.path}</p>
          {!fresh ? <RecoveryCard key={project.path} projectPath={project.path} onCreated={onCreated} onFresh={() => setFresh(true)} /> : <>
          <p>Get a short read of the files and recent changes, with one suggested next step.</p>
          <button type="button" className="button-primary" disabled={busy || !agent} onClick={() => void start('project')}>Explore this project</button></>}
          <button type="button" className="button-plain" disabled={busy} onClick={() => setProject(undefined)}>Choose another project</button>
        </> : <>
          <FolderIcon /><h2>Start with your work.</h2>
          <p>Choose a folder on your Mac. You decide what happens next.</p>
          {!native ? <input aria-label="Project folder" placeholder="/path/to/project" value={path} onChange={(e) => setPath(e.target.value)} /> : null}
          <button type="button" className="button-primary" disabled={busy || (!native && !path.trim())} onClick={() => void open()}>Open a project</button>
          <div className="first-run-sample"><p>Just looking around?</p>
            <button type="button" className="button-plain" disabled={busy || !sampleReady} onClick={() => void start('sample')}>Try a 90-second sample <span aria-hidden>→</span></button>
            <small>A real local app. Your agent starts it and shows you the result. Uses your agent subscription.</small>
          </div>
        </>}
        <p className="first-run-agent" role="status" hidden={Boolean(project) && !fresh}>{busy ? 'Opening your next step…' : agent ? `Using ${agentName(agent)} with its default model.` : agents ? 'No supported agent found. Install and sign in to an agent, or skip for now.' : 'Checking installed agents…'}</p>
        {agent === 'antigravity' && !project ? <small>The sample needs Claude Code, Codex or OpenCode for preview controls. Antigravity can explore your project.</small> : null}
        {error ? <p className="first-run-error" role="alert">{error}</p> : null}
      </section>
    </main>
  </div>
}
