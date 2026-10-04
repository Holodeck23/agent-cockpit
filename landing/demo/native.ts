import { projectPath, state, previewListeners, threadListeners, tell } from './state'
const unavailable = () => { tell('native', 'This action needs the installed Mac app.') }
export const native = {
  platform: 'darwin',
  pickFolder: async () => projectPath,
  newProject: async () => { unavailable(); return undefined },
  setTheme: () => {}, setActivity: () => {}, notify: () => {},
  appVersion: async () => undefined,
  releaseNotes: async () => ({ version: 'Demo', body: 'Install Cockpit to use native Mac features.' }),
  onShowReleaseNotes: () => () => {}, onFullScreen: () => () => {},
  revealTranscript: unavailable, openFolder: unavailable,
  fileAction: async () => 'Opening Finder or trashing a file needs the installed app.',
  copyText: (text: string) => { void navigator.clipboard?.writeText(text).catch(() => tell('native', 'Clipboard access is unavailable in this browser.')) },
  openPreview: (url: string) => previewListeners.forEach(fn => fn(url)),
  onPreviewOpen: (fn: (url: string) => void) => { previewListeners.add(fn); return () => { previewListeners.delete(fn) } },
  onOpenThread: (fn: (id: string) => void) => {
    threadListeners.add(fn)
    const timer = setTimeout(() => { if (!state.director && state.threads.has('garden')) fn('garden') }, 150)
    return () => { clearTimeout(timer); threadListeners.delete(fn) }
  },
}
