import { useEffect, useState } from 'react'
import { native } from '../native.ts'
import { REPORTS_WHAT } from '../reports-copy.ts'

/**
 * Asks once, in a build that sends crash and error reports, whether it may (electron/telemetry.ts).
 * Shown over the first-run screen as well as the app: a first launch starts there. Settings changes
 * the answer later.
 */
export function ReportsAsk() {
  const [ask, setAsk] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let live = true
    void native?.reports?.().then((status) => { if (live) setAsk(Boolean(status?.available && !status.decided)) }, () => undefined)
    return () => { live = false }
  }, [])
  if (!ask) return null
  const answer = async (on: boolean): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const status = await native?.reports?.(on)
      if (!status?.decided || status.reports !== on) throw new Error('Choice was not accepted')
      setAsk(false)
    } catch {
      setError('Could not change crash reporting. Please try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="toast reports-toast" role="dialog" aria-label="Crash reports">
      <span><strong>Send crash reports to Cockpit's developer?</strong> {REPORTS_WHAT}
        {error ? <span role="alert"> {error}</span> : null}</span>
      <button type="button" className="button-primary" disabled={saving} onClick={() => { void answer(true) }}>Send reports</button>
      <button type="button" className="button-soft" disabled={saving} onClick={() => { void answer(false) }}>No thanks</button>
    </div>
  )
}
