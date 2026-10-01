import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { api, type PageMode } from './api.ts'
import { PairPhone } from './components/PairPhone.tsx'
import { native } from './native.ts'
import './styles/tokens.css'
import './styles/chrome.css'
import './styles/list.css'
import './styles/thread.css'
import './styles/activity.css'
import './styles.css'
import './styles/workflows.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
if (native) document.documentElement.classList.add('in-app')

// The same page runs in the Mac's window and on a paired phone. An unpaired phone
// only gets the pairing screen; the server refuses everything else anyway.
async function boot(container: HTMLElement): Promise<void> {
  const page: PageMode = await api.pageMode().catch((): PageMode => ({ mode: 'local' }))
  if (page.mode === 'remote') document.documentElement.classList.add('phone')
  createRoot(container).render(
    <StrictMode>
      {page.mode === 'remote' && !page.paired ? <PairPhone login={page.login} /> : <App page={page} />}
    </StrictMode>,
  )
}
void boot(root)

import './styles/files.css'
import './styles/picker.css'
import './styles/git.css'
import './styles/processes.css'
import './styles/conversation-actions.css'
import './styles/phone.css'
