import { useEffect, useState } from 'react'
import { native } from '../native.ts'
import { REPORTS_WHAT } from '../reports-copy.ts'

const KEY = 'cockpit:reports-notice-seen'

/**
 * Crash and error reports are on by default (electron/telemetry.ts). The first launch says so once,
 * and where to turn them off; it is a notice, not a question. Shown over the first-run screen as
 * well as the app, as a first launch starts there.
 */
export function ReportsNotice() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let live = true
    let seen = false
    try { seen = localStorage.getItem(KEY) === '1' } catch { /* no storage: say it this time */ }
    if (!seen) void native?.reports?.().then((status) => { if (live) setShow(Boolean(status?.available && status.reports)) }, () => undefined)
    return () => { live = false }
  }, [])
  if (!show) return null
  const close = (): void => {
    setShow(false)
    try { localStorage.setItem(KEY, '1') } catch { /* shown again next launch */ }
  }
  return (
    <div className="toast reports-toast" role="status" aria-label="Crash reports">
      <span><strong>Cockpit sends crash reports to its developer.</strong> {REPORTS_WHAT} Turn them off in Settings.</span>
      <button type="button" className="button-soft" onClick={close}>OK</button>
    </div>
  )
}
