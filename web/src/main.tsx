import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { api, ApiError, type PageMode } from './api.ts'
import { BetaTermsGate } from './components/BetaTerms.tsx'
import { Mark } from './components/icons.tsx'
import { PairPhone } from './components/PairPhone.tsx'
import { native } from './native.ts'
import { trackWindowChrome } from './window-chrome.ts'
import './styles/tokens.css'
import './styles/chrome.css'
import './styles/list.css'
import './styles/thread.css'
import './styles/scanner.css'
import './styles/reply.css'
import './styles/activity.css'
import './styles.css'
import './styles/workflows.css'
import './styles/gallery.css'
import './styles/appearance.css'
import './styles/project-settings.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
if (native) {
  document.documentElement.classList.add('in-app')
  trackWindowChrome(native)
  // Uncaught page errors go to a crash report (sent once the beta terms are accepted).
  const report = native.pageError?.bind(native)
  if (report) {
    window.addEventListener('error', (event) => {
      const error: unknown = event.error
      report({ message: error instanceof Error ? error.message : String(event.message), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) })
    })
    window.addEventListener('unhandledrejection', (event) => {
      const reason: unknown = event.reason
      report({ message: reason instanceof Error ? reason.message : String(reason), ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}) })
    })
  }
}

// Only the Mac's own window (or its loopback address) can say "this is the Mac" without the server's
// answer. A phone that cannot reach /api/remote/me must not fall back to the desktop app.
const onTheMac = native !== undefined || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

/** Where this page runs; a failed lookup is tried again, since a phone's link drops now and then. */
async function pageMode(): Promise<PageMode> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.pageMode()
    } catch (error) {
      if (onTheMac) return { mode: 'local' }
      // A refusal (two sign-ins in the browser, say) will not change by asking again.
      if (attempt === 3 || (error instanceof ApiError && error.status < 500)) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 750))
    }
  }
}

function PageUnavailable({ message }: { message: string }) {
  return (
    <main className="pair">
      <Mark className="pair-mark" />
      <h1>Cockpit did not open</h1>
      <p className="pair-error" role="alert">{message}</p>
      <button type="button" className="pair-ask" onClick={() => window.location.reload()}>Try again</button>
    </main>
  )
}

// The same page runs in the Mac's window and on a paired phone. An unpaired phone
// only gets the pairing screen; the server refuses everything else anyway.
async function boot(container: HTMLElement): Promise<void> {
  let page: PageMode
  try {
    page = await pageMode()
  } catch (error) {
    document.documentElement.classList.add('phone')
    createRoot(container).render(
      <StrictMode>
        <PageUnavailable message={error instanceof ApiError ? error.message : 'Your Mac did not answer. Check that Tailscale is connected and Cockpit is open on the Mac.'} />
      </StrictMode>,
    )
    return
  }
  if (page.mode === 'remote') document.documentElement.classList.add('phone')
  createRoot(container).render(
    <StrictMode>
      {page.mode === 'remote' && !page.paired ? <PairPhone login={page.login} /> : page.mode === 'remote' ? <App page={page} /> : <BetaTermsGate><App page={page} /></BetaTermsGate>}
    </StrictMode>,
  )
}
void boot(root)

import './styles/files.css'
import './styles/picker.css'
import './styles/git.css'
import './styles/workspaces.css'
import './styles/feedback.css'
import './styles/processes.css'
import './styles/results.css'
import './styles/conversation-actions.css'
import './styles/preview.css'
import './styles/phone.css'

import './styles/first-run.css'
