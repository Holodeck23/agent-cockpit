import type { ProcessInfo } from '../api.ts'
import { usePopover } from '../usePopover.ts'
import { StopIcon } from './icons.tsx'

// The project's running processes (dev servers the agent started through the
// cockpit MCP), as a small chip in the thread's status line. Opens a list with
// each process's URL and a Stop button. Hidden while nothing is running.

interface ProcessChipProps {
  processes: ProcessInfo[]
  onStop: (id: string) => void
}

/** ":5173" for a local URL, else the process name. */
export function shortLabel(info: ProcessInfo): string {
  if (!info.url) return info.name
  try {
    const { port } = new URL(info.url)
    return port ? `:${port}` : info.url
  } catch {
    return info.name
  }
}

export function stateText(info: ProcessInfo): string {
  if (info.status === 'running') return 'Running'
  if (info.status === 'stopping') return 'Stopping…'
  if (info.signal) return `Stopped (${info.signal})`
  return info.exitCode === 0 ? 'Exited' : `Exited with code ${info.exitCode ?? '?'}`
}

export function ProcessChip({ processes, onStop }: ProcessChipProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const live = processes.filter((p) => p.status !== 'exited')
  if (live.length === 0 && !open) return null
  const first = live[0]

  return (
    <div className="process-chip-wrap" ref={ref}>
      <button
        type="button"
        className="process-chip"
        aria-expanded={open}
        aria-label={`${live.length} running process${live.length === 1 ? '' : 'es'}`}
        onClick={() => setOpen(!open)}
      >
        <span className="process-dot" aria-hidden />
        {live.length === 1 ? '1 process' : `${live.length} processes`}
        {live.length === 1 && first ? <span className="process-chip-port">· {shortLabel(first)}</span> : null}
      </button>
      {open ? (
        <div className="menu process-menu" role="dialog" aria-label="Processes">
          <p className="menu-label">Processes in this project</p>
          <ul className="menu-list">
            {processes.map((p) => (
              <li key={p.id} className={`process-row process-${p.status}`}>
                <span className="process-dot" aria-hidden />
                <div className="process-text">
                  <span className="process-name">{p.name}</span>
                  <span className="process-meta">
                    {stateText(p)}
                    {p.name !== p.command ? <code title={p.command}>{p.command}</code> : null}
                  </span>
                  {p.url && p.status !== 'exited' ? (
                    <a className="process-url" href={p.url} target="_blank" rel="noreferrer">
                      {p.url}
                    </a>
                  ) : null}
                </div>
                {p.status === 'running' ? (
                  <button type="button" className="process-stop" aria-label={`Stop ${p.name}`} title="Stop" onClick={() => onStop(p.id)}>
                    <StopIcon />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
