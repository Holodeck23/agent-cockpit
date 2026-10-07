import { useState } from 'react'
import type { ProcessInfo } from '../api.ts'
import { OUTCOME_TITLE, postTicket, requestTicket, type ViewOutcome } from '../phone-preview.ts'
import { usePopover } from '../usePopover.ts'
import { shortLabel } from './ProcessChip.tsx'

// The phone's way into a running dev server (H5): this project's apps that show a local address,
// each with View app. The app opens on its own origin in its own tab; anything that stops it is
// said here in plain words, with a way back to the conversation. Nothing here starts an app or
// changes Tailscale.

interface PhoneAppsProps {
  /** This project's processes. */
  processes: ProcessInfo[]
}

type Shown = { readonly id: string; readonly name: string } & ({ readonly kind: 'loading' } | Exclude<ViewOutcome, { kind: 'opened' }>)

export function PhoneApps({ processes }: PhoneAppsProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [shown, setShown] = useState<Shown>()
  const [opened, setOpened] = useState<string>()
  const apps = processes.filter((p) => p.status === 'running' && p.url)
  if (apps.length === 0 && !open) return null

  const view = async (app: ProcessInfo): Promise<void> => {
    setOpened(undefined)
    setShown({ id: app.id, name: app.name, kind: 'loading' })
    const result = await requestTicket(app.id)
    if ('ticket' in result) {
      postTicket(result)
      setShown(undefined)
      setOpened(app.name)
      return
    }
    setShown({ id: app.id, name: app.name, ...result })
  }
  const back = (): void => { setShown(undefined); setOpen(false) }

  return (
    <div className="process-chip-wrap phone-apps" ref={ref}>
      <button type="button" className="process-chip" aria-expanded={open} aria-label={`${apps.length} app${apps.length === 1 ? '' : 's'} to view`}
        onClick={() => { setShown(undefined); setOpen(!open) }}>
        <span className="process-dot" aria-hidden />
        {apps.length === 1 ? '1 app' : `${apps.length} apps`}
      </button>
      {open ? (
        <div className="menu process-menu phone-apps-menu" role="dialog" aria-label="Apps">
          {shown && shown.kind === 'loading' ? (
            <div className="phone-apps-state" role="status" data-state="loading">
              <strong>Opening {shown.name}…</strong>
              <p>It opens in its own tab. Come back to this tab for the conversation.</p>
              <button type="button" className="phone-toggle off" onClick={back}>Back to conversation</button>
            </div>
          ) : shown ? (
            <div className="phone-apps-state" role="alert" data-state={shown.kind}>
              <strong>{OUTCOME_TITLE[shown.kind]}</strong>
              <p>{shown.message}</p>
              <div className="phone-apps-actions">
                <button type="button" className="phone-toggle" onClick={() => { const app = apps.find((a) => a.id === shown.id); if (app) void view(app); else back() }}>Try again</button>
                <button type="button" className="phone-toggle off" onClick={back}>Back to conversation</button>
              </div>
            </div>
          ) : (
            <>
              <p className="menu-label">Apps in this project</p>
              {opened ? <p className="phone-apps-opened" role="status">{opened} opened in its own tab.</p> : null}
              {apps.length === 0 ? <p className="phone-apps-none">Nothing with a web address is running now.</p> : null}
              <ul className="menu-list">
                {apps.map((app) => (
                  <li key={app.id} className="process-row process-running">
                    <span className="process-dot" aria-hidden />
                    <div className="process-text">
                      <span className="process-name">{app.name}</span>
                      <span className="process-meta">Running · {shortLabel(app)}</span>
                    </div>
                    <button type="button" className="phone-view-app" onClick={() => void view(app)}>View app</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
