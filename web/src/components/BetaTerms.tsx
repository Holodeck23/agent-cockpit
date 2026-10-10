import { useEffect, useState, type ReactNode } from 'react'
import { native } from '../native.ts'
import { Mark } from './icons.tsx'

const TERMS_URL = 'https://github.com/Holodeck23/agent-cockpit/blob/main/BETA-TERMS.md'

/**
 * The beta is conditional on its terms (BETA-TERMS.md, David 2026-10-08): crash and error reports
 * are sent, with no switch to turn them off. Accepted when installing from Terminal, else here on
 * the first launch: Agree and continue, or Quit. Builds without reports (development) skip it.
 */
export function BetaTermsGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'ask' | 'accepted'>(native?.betaTerms ? 'checking' : 'accepted')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!native?.betaTerms) return
    let live = true
    // Unreadable status: the app opens; main still sends nothing until accepted.
    void native.betaTerms().then((status) => { if (live) setState(status?.available && !status.accepted ? 'ask' : 'accepted') }, () => { if (live) setState('accepted') })
    return () => { live = false }
  }, [])
  if (state === 'accepted') return <>{children}</>
  if (state === 'checking') return <div className="app first-run"><main className="first-run-body" role="status">Opening Cockpit…</main></div>
  const answer = (choice: 'accept' | 'decline'): void => {
    setBusy(true)
    void native?.betaTerms?.(choice).then((status) => { if (choice === 'accept' && status?.accepted) setState('accepted') }).finally(() => setBusy(false))
  }
  return (
    <div className="app first-run">
      <header className="first-run-bar"><Mark /><span>Cockpit</span></header>
      <main className="beta-terms" role="dialog" aria-labelledby="beta-terms-title">
        <h1 id="beta-terms-title">Cockpit beta terms</h1>
        <p>Cockpit is in beta. Using it means you agree to send crash and error reports to its developer, so problems get found and fixed. They cannot be turned off during the beta; to stop them, stop using Cockpit.</p>
        <ul>
          <li>A report holds the error message and stack trace, Cockpit's version, and the macOS version and kind of Mac.</li>
          <li>Your home folder is replaced with ~. Your machine name, user, time zone, language, screen, screenshots, recordings, crash memory dumps and file contents are never sent. Error text can still name a project or file.</li>
          <li>Reports go to Sentry (EU) and are deleted after its retention period.</li>
        </ul>
        <p><a href={TERMS_URL} target="_blank" rel="noreferrer">Read the full beta terms</a></p>
        <div className="beta-terms-actions">
          <button type="button" className="button-primary" disabled={busy} onClick={() => answer('accept')}>Agree and continue</button>
          <button type="button" className="button-soft" disabled={busy} onClick={() => answer('decline')}>Quit</button>
        </div>
      </main>
    </div>
  )
}
