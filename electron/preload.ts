import { contextBridge, ipcRenderer } from 'electron'

// The only native surface the page gets. Everything else goes through the
// loopback HTTP API, exactly as in the browser.
const cockpit = {
  platform: process.platform,
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('cockpit:pick-folder') as Promise<string | undefined>,
  /** Native chrome (traffic lights, menus) follows the page's theme choice. */
  setTheme: (mode: 'system' | 'light' | 'dark'): void => ipcRenderer.send('cockpit:set-theme', mode),
  /** Shows a thread's transcript in Finder. Only paths inside the cockpit's own thread folder are honoured. */
  revealTranscript: (path: string): void => ipcRenderer.send('cockpit:reveal-transcript', path),
  /** Opens a project folder in Finder; ignored unless Cockpit lists it as a project. */
  openFolder: (path: string): void => ipcRenderer.send('cockpit:open-folder', path),
  /** Opens a file in its default app, shows it in Finder, or moves it to the Trash. Resolves to an error message, if any. */
  fileAction: (request: { projectPath: string; space: 'project' | 'documents'; path: string; action: 'open' | 'reveal' | 'trash' }): Promise<string | undefined> =>
    ipcRenderer.invoke('cockpit:file-action', request) as Promise<string | undefined>,
  /** Drives the Dock icon: animated while agents work, badged with how many need you. */
  setActivity: (activity: { working: number; needs: number }): void => ipcRenderer.send('cockpit:activity', activity),
}

contextBridge.exposeInMainWorld('cockpit', cockpit)

export type CockpitBridge = typeof cockpit
