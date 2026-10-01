import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OutputLine } from '../../../server/processes/output.ts'
import { api, type ProcessInfo, type Project } from '../api.ts'
import { SearchIcon, TerminalIcon } from './icons.tsx'
import { shortLabel, stateText } from './ProcessChip.tsx'

// Every process the cockpit runner started in this project (dev servers, watchers),
// with a live log beside the selected one. Agents start them through the cockpit MCP;
// this page lets the person follow, stop and restart them.

interface ProcessesProps {
  project?: Project
  /** All projects' processes, newest first, kept current by the event stream. */
  processes: ProcessInfo[]
  onError: (message: string) => void
}

const MAX_LINES = 2000
const POLL_MS = 1000

interface Log { readonly id: string; readonly lines: readonly OutputLine[]; readonly next: number; readonly dropped: number }

function useProcessLog(id: string | undefined): Log | undefined {
  const [log, setLog] = useState<Log>()
  useEffect(() => {
    setLog(undefined)
    if (!id) return
    let live = true
    let next: number | undefined
    const tick = async (): Promise<void> => {
      try {
        const read = await api.readProcess(id, next === undefined ? { tail: 500 } : { since: next })
        if (!live) return
        const first = next === undefined
        next = read.next
        setLog((prev) => first || !prev ? { id, lines: read.lines, next: read.next, dropped: read.dropped }
          : read.lines.length ? { ...prev, lines: [...prev.lines, ...read.lines].slice(-MAX_LINES), next: read.next } : prev)
      } catch {
        // The process may have been pruned; the list will drop it.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [id])
  return log?.id === id ? log : undefined
}

export function Processes({ project, processes, onError }: ProcessesProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [pending, setPending] = useState('')
  const mine = project ? processes.filter((p) => p.projectPath === project.path) : []
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = mine.filter((p) => words.every((w) => `${p.name} ${p.command} ${p.url ?? ''}`.toLowerCase().includes(w)))
  // Follow the newest process until the person picks one.
  const selected = mine.find((p) => p.id === selectedId) ?? mine[0]
  const log = useProcessLog(selected?.id)
  const running = mine.filter((p) => p.status !== 'exited').length

  const box = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [log])

  const act = async (what: 'stop' | 'restart', info: ProcessInfo): Promise<void> => {
    setPending(`${what}:${info.id}`)
    try {
      if (what === 'stop') await api.stopProcess(info.id)
      else setSelectedId((await api.restartProcess(info.id)).id)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending('')
    }
  }

  if (!project) return <main className="processes-empty-page">Open a project to see its processes.</main>

  return (
    <div className="processes-layout">
      <nav className="process-list" aria-label="Processes">
        <header>
          <div><span className="workflow-kicker">{project.name}</span><h1>Processes</h1></div>
          <span className="process-count">{running} running</span>
        </header>
        <label className="workflow-search">
          <SearchIcon />
          <input type="search" aria-label="Search processes" placeholder="Search processes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {mine.length === 0 ? (
          <div className="workflow-list-empty">
            <TerminalIcon />
            <strong>Nothing running yet</strong>
            <span>When you ask your agent to start your site or server, it shows up here with its output.</span>
          </div>
        ) : null}
        {mine.length > 0 && shown.length === 0 ? <p className="workflow-none" role="status">No processes match.</p> : null}
        <ul className="process-items">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" className={`process-item process-${p.status}${p.id === selected?.id ? ' selected' : ''}`}
                aria-current={p.id === selected?.id} onClick={() => { setSelectedId(p.id); pinned.current = true }}>
                <span className="process-dot" aria-hidden />
                <span className="process-text">
                  <span className="process-name">{p.name}</span>
                  <span className="process-meta">{stateText(p)}{p.url && p.status !== 'exited' ? ` · ${shortLabel(p)}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="process-detail">
        {selected ? (
          <>
            <header className="process-detail-head">
              <div className="process-detail-title">
                <h2>{selected.name}</h2>
                <code title={selected.command}>{selected.command}</code>
                <span className={`process-state process-${selected.status}`}><span className="process-dot" aria-hidden />{stateText(selected)}</span>
                {selected.url && selected.status !== 'exited' ? <a className="process-url" href={selected.url} target="_blank" rel="noreferrer">{selected.url}</a> : null}
              </div>
              <div className="process-actions">
                <button type="button" disabled={Boolean(pending)} onClick={() => void act('restart', selected)}>
                  {pending === `restart:${selected.id}` ? 'Restarting…' : selected.status === 'exited' ? 'Start again' : 'Restart'}
                </button>
                {selected.status === 'running' ? (
                  <button type="button" className="danger" disabled={Boolean(pending)} onClick={() => void act('stop', selected)}>
                    {pending === `stop:${selected.id}` ? 'Stopping…' : 'Stop'}
                  </button>
                ) : null}
              </div>
            </header>
            <pre ref={box} className="process-log" aria-label={`Output of ${selected.name}`} tabIndex={0}
              onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
              {log?.dropped ? <span className="log-note">{log.dropped} earlier lines not kept</span> : null}
              {log?.lines.map((line) => <span key={line.seq} className={line.stream === 'stderr' ? 'log-err' : undefined}>{line.text}{'\n'}</span>)}
              {log && log.lines.length === 0 ? <span className="log-note">No output yet.</span> : null}
            </pre>
          </>
        ) : (
          <p className="process-pick">Select a process to follow its output.</p>
        )}
      </main>
    </div>
  )
}
