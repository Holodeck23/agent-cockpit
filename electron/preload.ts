import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { NewProject } from './new-project.ts'
import type { ReleaseNotes } from './updates.ts'

type CopyOutcome = { copied: string[]; skipped: Array<{ name: string; reason: string }> } | { error: string }

// The only native surface the page gets. Everything else goes through the
// loopback HTTP API, exactly as in the browser.
const cockpit = {
  platform: process.platform,
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('cockpit:pick-folder') as Promise<string | undefined>,
  /** Native Save panel for a new project's name and location; creates the folder. */
  newProject: (near?: string): Promise<NewProject | undefined> => ipcRenderer.invoke('cockpit:new-project', near) as Promise<NewProject | undefined>,
  /** Native chrome (traffic lights, menus) follows the page's theme choice. */
  setTheme: (mode: 'system' | 'light' | 'dark'): void => ipcRenderer.send('cockpit:set-theme', mode),
  /** Shows a thread's transcript in Finder. Only paths inside the cockpit's own thread folder are honoured. */
  revealTranscript: (path: string): void => ipcRenderer.send('cockpit:reveal-transcript', path),
  /** Opens a project folder in Finder; ignored unless Cockpit lists it as a project. */
  openFolder: (path: string): void => ipcRenderer.send('cockpit:open-folder', path),
  /** Opens a file in its default app, shows it in Finder, or moves it to the Trash. Resolves to an error message, if any. */
  fileAction: (request: { projectPath: string; space: 'project' | 'documents'; path: string; action: 'open' | 'reveal' | 'trash' }): Promise<string | undefined> =>
    ipcRenderer.invoke('cockpit:file-action', request) as Promise<string | undefined>,
  /** Copies files dropped from Finder into a folder of the project (or its documents); never overwrites. */
  copyInto: (request: { projectPath: string; space: 'project' | 'documents'; folder: string; files: readonly File[] }): Promise<CopyOutcome> =>
    ipcRenderer.invoke('cockpit:copy-into', { ...request, files: undefined, sources: request.files.map((f) => webUtils.getPathForFile(f)) }) as Promise<CopyOutcome>,
  /** Drives the Dock icon: animated while agents work, badged with how many need you. */
  setActivity: (activity: { working: number; needs: number }): void => ipcRenderer.send('cockpit:activity', activity),
  /** Opens a local dev-server URL in Cockpit's embedded preview pane. */
  openPreview: (url: string): void => ipcRenderer.send('cockpit:open-preview', url),
  /** The process runner's open_preview tool reaches the page through this event. */
  onPreviewOpen: (listener: (url: string) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, url: unknown): void => { if (typeof url === 'string') listener(url) }
    ipcRenderer.on('cockpit:preview-open', receive)
    return () => ipcRenderer.removeListener('cockpit:preview-open', receive)
  },
  copyText: (text: string): void => ipcRenderer.send('cockpit:copy-text', text),
  notify: (notification: { threadId: string; title: string; body: string }): void => ipcRenderer.send('cockpit:notify', notification),
  onOpenThread: (listener: (threadId: string) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, id: unknown): void => { if (typeof id === 'string') listener(id) }
    ipcRenderer.on('cockpit:open-thread', receive)
    return () => ipcRenderer.removeListener('cockpit:open-thread', receive)
  },
  appVersion: (): Promise<string | undefined> => ipcRenderer.invoke('cockpit:app-version') as Promise<string | undefined>,
  releaseNotes: (): Promise<ReleaseNotes> => ipcRenderer.invoke('cockpit:release-notes') as Promise<ReleaseNotes>,
  onShowReleaseNotes: (listener: () => void): (() => void) => {
    const receive = (): void => listener()
    ipcRenderer.on('cockpit:show-release-notes', receive)
    return () => ipcRenderer.removeListener('cockpit:show-release-notes', receive)
  },
  onFullScreen: (listener: (fullScreen: boolean) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, value: unknown): void => { if (typeof value === 'boolean') listener(value) }
    ipcRenderer.on('cockpit:full-screen', receive)
    return () => ipcRenderer.removeListener('cockpit:full-screen', receive)
  },
}

contextBridge.exposeInMainWorld('cockpit', cockpit)

export type CockpitBridge = typeof cockpit
