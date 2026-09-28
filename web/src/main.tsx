import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { native } from './native.ts'
import './styles/tokens.css'
import './styles/chrome.css'
import './styles/list.css'
import './styles/thread.css'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
if (native) document.documentElement.classList.add('in-app')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
