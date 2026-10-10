import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { api, type PageMode } from './api.ts'
import { BetaTermsGate } from './components/BetaTerms.tsx'
import { PairPhone } from './components/PairPhone.tsx'
import { native } from './native.ts'
import { trackWindowChrome } from './window-chrome.ts'
import '@fontsource-variable/fraunces/full.css'
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

// The same page runs in the Mac's window and on a paired phone. An unpaired phone
// only gets the pairing screen; the server refuses everything else anyway.
async function boot(container: HTMLElement): Promise<void> {
  const page: PageMode = await api.pageMode().catch((): PageMode => ({ mode: 'local' }))
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
