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
  /** Drives the Dock icon: animated while agents work, badged with how many need you. */
  setActivity: (activity: { working: number; needs: number }): void => ipcRenderer.send('cockpit:activity', activity),
}

contextBridge.exposeInMainWorld('cockpit', cockpit)

export type CockpitBridge = typeof cockpit
