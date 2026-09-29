import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import { api, type RemoteStatus } from '../api.ts'
import { usePopover } from '../usePopover.ts'
import { PhoneIcon } from './icons.tsx'

// Phone access settings, in the sub-nav: turn it on, show the Tailscale address
// (and a QR code for the phone's camera), approve pairing requests, and revoke
// paired phones.

interface PhonePanelProps {
  status: RemoteStatus | undefined
  onError: (message: string) => void
}
interface PhoneButtonProps extends PhonePanelProps {
  /** The panel lists pairing requests itself, so the banner hides while it is open. */
  onOpenChange: (open: boolean) => void
}

function Qr({ url }: { url: string }) {
  const svg = useMemo(() => {
    const code = qrcode(0, 'M')
    code.addData(url)
    code.make()
    return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [url])
  // The SVG is generated locally from our own URL, never from outside input.
  return <div className="phone-qr" aria-label={`QR code for ${url}`} role="img" dangerouslySetInnerHTML={{ __html: svg }} />
}

const ago = (iso: string): string => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

export function PairingRequests({ status, onError }: PhonePanelProps) {
  if (!status?.pairings.length) return null
  const decide = (id: string, approve: boolean) => void api.decidePairing(id, approve).catch((e: unknown) => onError(String(e)))
  return (
    <ul className="pairing-list" aria-label="Phones asking to connect">
      {status.pairings.map((p) => (
        <li key={p.id} className="pairing-row">
          <div className="pairing-text">
            <strong>{p.name}</strong> wants to open Cockpit
            <span className="pairing-meta">{p.login} · check the phone shows <b className="pairing-code">{p.code}</b></span>
          </div>
          <button type="button" className="pairing-deny" onClick={() => decide(p.id, false)}>Deny</button>
          <button type="button" className="pairing-allow" onClick={() => decide(p.id, true)}>Allow</button>
        </li>
      ))}
    </ul>
  )
}

export function PhonePanel({ status, onError, onOpenChange }: PhoneButtonProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  useEffect(() => onOpenChange(open), [open, onOpenChange])
  const [busy, setBusy] = useState(false)
  const pending = status?.pairings.length ?? 0
  const toggle = (enabled: boolean): void => {
    setBusy(true)
    api.setRemote(enabled).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
  }
  const running = Boolean(status?.enabled && status.running && status.url)

  return (
    <div className="phone-wrap" ref={ref}>
      <button type="button" className="icon-button phone-button" aria-label="Phone access" title="Phone access" aria-expanded={open} onClick={() => setOpen(!open)}>
        <PhoneIcon />
        {pending > 0 ? <span className="phone-badge" aria-label={`${pending} waiting`}>{pending}</span> : running ? <span className="phone-on" aria-hidden /> : null}
      </button>
      {open ? (
        <div className="menu phone-menu" role="dialog" aria-label="Phone access">
          <p className="menu-label">Phone access</p>
          {running && status?.url ? (
            <div className="phone-body">
              <p className="phone-note">Open this address on a phone signed in to Tailscale as <b>{status.allowedLogins.join(', ')}</b>.</p>
              <Qr url={status.url} />
              <a className="phone-url" href={status.url} target="_blank" rel="noreferrer">{status.url.replace('https://', '')}</a>
              <PairingRequests status={status} onError={onError} />
              {status.devices.length > 0 ? <p className="menu-label">Paired phones</p> : null}
              <ul className="menu-list">
                {status.devices.map((d) => (
                  <li key={d.id} className="device-row">
                    <div className="device-text"><span className="device-name">{d.name}</span><span className="device-meta">Last used {ago(d.lastSeenAt)}</span></div>
                    <button type="button" className="device-revoke" onClick={() => void api.revokeDevice(d.id).catch((e: unknown) => onError(String(e)))}>Remove</button>
                  </li>
                ))}
              </ul>
              <button type="button" className="phone-toggle off" disabled={busy} onClick={() => toggle(false)}>Turn off phone access</button>
            </div>
          ) : (
            <div className="phone-body">
              <p className="phone-note">
                Check on conversations and answer approvals from your phone, over Tailscale. Only your Tailscale account can connect, and each phone is approved here first.
              </p>
              {status?.error ? <p className="phone-error" role="alert">{status.error}</p> : null}
              <button type="button" className="phone-toggle" disabled={busy} onClick={() => toggle(true)}>
                {busy ? 'Turning on…' : status?.enabled ? 'Try again' : 'Turn on phone access'}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
