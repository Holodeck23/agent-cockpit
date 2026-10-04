import { createRoot } from 'react-dom/client'
import { App } from '../../web/src/App'
import { reset, state, threadListeners, tell } from './state'
import { demoStorage } from './storage'
import '../../web/src/styles/tokens.css'
import '../../web/src/styles/chrome.css'
import '../../web/src/styles/list.css'
import '../../web/src/styles/thread.css'
import '../../web/src/styles/reply.css'
import '../../web/src/styles/activity.css'
import '../../web/src/styles.css'
import '../../web/src/styles/workflows.css'
import '../../web/src/styles/gallery.css'
import '../../web/src/styles/appearance.css'
import '../../web/src/styles/project-settings.css'
import '../../web/src/styles/files.css'
import '../../web/src/styles/picker.css'
import '../../web/src/styles/git.css'
import '../../web/src/styles/processes.css'
import '../../web/src/styles/conversation-actions.css'
import '../../web/src/styles/preview.css'
import '../../web/src/styles/phone.css'
import '../../web/src/styles/first-run.css'
import './readability.css'

const root = createRoot(document.getElementById('root')!)
let revision = 0
const mount = () => root.render(<App key={++revision} />)
mount()
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.source !== 'cockpit-tour') return
  const action = event.data.action
  if (action === 'reset' || action === 'recovery') {
    demoStorage.clear(); reset(action === 'recovery'); mount(); tell(action === 'recovery' ? 'recovery' : 'approval'); return
  }
  if (state.director) { tell('native', 'Open the sample project and resume first, or choose Reset demo.'); return }
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.subnav-item')].find(t => t.textContent?.trim() === action)
  tab?.click()
  if (action === 'Conversations') threadListeners.forEach(fn => fn('theme'))
})
// Explain simulation boundaries at the point of use, without changing production components.
const observer = new MutationObserver(() => {
  const area = document.querySelector<HTMLTextAreaElement>('.composer textarea')
  if (area) area.placeholder = 'Try “start the app”, or leave a sample message…'
})
observer.observe(document.getElementById('root')!, { subtree: true, childList: true })
tell('ready')
window.addEventListener('keydown', event => { if (event.key === 'Escape') tell('escape') })
document.addEventListener('click', event => {
  const tab = (event.target as Element).closest('.subnav-item')
  if (innerWidth <= 760 && tab && tab.textContent?.trim() !== 'Conversations') {
    document.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click()
  }
}, true)
