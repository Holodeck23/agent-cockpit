import { useCallback, useEffect, useState } from 'react'
import { api, type PreviewsStatus } from '../api.ts'

// Enable phone previews (H5, W11.1), inside the Phone access panel: which running apps a paired
// phone may open, each on its own HTTPS address. Each needs one `tailscale serve` entry on this
// Mac; the exact command is shown first and runs only when the person clicks it. Places are never
// reused, so an old phone tab can never reach a different app.

interface PhonePreviewsProps {
  onError: (message: string) => void
}

const folder = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export function PhonePreviews({ onError }: PhonePreviewsProps) {
  const [status, setStatus] = useState<PreviewsStatus>()
  const [busy, setBusy] = useState('')
  const load = useCallback(() => { api.phonePreviews().then(setStatus, (e: unknown) => onError(e instanceof Error ? e.message : String(e))) }, [onError])
  useEffect(load, [load])

  const run = async (key: string, action: () => Promise<PreviewsStatus>): Promise<void> => {
    setBusy(key)
    try { setStatus(await action()) } catch (e) { onError(e instanceof Error ? e.message : String(e)); load() } finally { setBusy('') }
  }

  if (!status) return <p className="phone-note" role="status">Checking phone previews…</p>
  const live = status.services.filter((s) => !s.retired)
  const reserved = status.services.length - live.length

  return (
    <section className="phone-previews" aria-label="Enable phone previews">
      <p className="menu-label">Enable phone previews</p>
      <p className="phone-note">Open a running app on the phone, each on its own address. Each one needs one Tailscale command on this Mac, shown here first; nothing changes until you click it.</p>
      {status.error ? <p className="phone-error" role="alert">{status.error}</p> : null}
      <ul className="menu-list">
        {live.map((s) => (
          <li key={s.id} className="preview-row" data-tailscale={s.tailscale}>
            <div className="device-text">
              <span className="device-name">{s.name}</span>
              <span className="device-meta">{folder(s.projectPath)}{s.processId ? ' · running' : ' · not running'}</span>
            </div>
            {s.open && s.tailscale === 'cockpit' ? (
              <>
                <span className="preview-on">On · {s.origin?.replace('https://', '') ?? `HTTPS ${s.serve.httpsPort}`}</span>
                <button type="button" className="device-revoke" disabled={Boolean(busy)} title={`Runs: ${s.serve.undo}`}
                  onClick={() => void run(`off:${s.id}`, () => api.unservePhonePreview(s.id))}>{busy === `off:${s.id}` ? 'Turning off…' : 'Turn off'}</button>
              </>
            ) : s.tailscale === 'other' ? (
              <p className="phone-error preview-conflict">HTTPS {s.serve.httpsPort} on this Mac already goes to {s.other}. Cockpit leaves it alone.</p>
            ) : (
              <>
                <code className="preview-command">{s.serve.command}</code>
                <button type="button" className="pairing-allow" disabled={Boolean(busy) || !status.phoneAccess}
                  onClick={() => void run(`on:${s.id}`, () => api.servePhonePreview(s.id))}>{busy === `on:${s.id}` ? 'Running…' : 'Run this command'}</button>
                {s.tailscale === 'unknown' ? <span className="device-meta">Tailscale did not say what this address serves. Check it is connected.</span> : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {status.candidates.length ? <p className="menu-label">Running apps with a local address</p> : null}
      <ul className="menu-list">
        {status.candidates.map((c) => (
          <li key={c.processId} className="device-row">
            <div className="device-text"><span className="device-name">{c.name}</span><span className="device-meta">{folder(c.projectPath)} · {c.url}</span></div>
            <button type="button" className="device-revoke" disabled={Boolean(busy)}
              onClick={() => void run(`prep:${c.processId}`, async () => (await api.preparePhonePreview(c.processId)).status)}>Set up for phone</button>
          </li>
        ))}
      </ul>
      {live.length === 0 && status.candidates.length === 0 ? <p className="phone-note">Start an app (a dev server) in a project, and it shows up here.</p> : null}
      <p className="device-meta preview-limits">
        {status.services.length} of {status.limit} places used{reserved ? `, ${reserved} kept for removed projects` : ''}. Works with apps that sign in with server
        sessions. Apps that need JavaScript-readable cookies, HTTP Basic sign-in or hard-coded localhost addresses may not work on the phone.
      </p>
    </section>
  )
}
