import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { NewProject } from './new-project.ts'
import type { ReleaseNotes } from './updates.ts'
import type { ReportsStatus } from './telemetry.ts'
import type { PreviewOpen } from '../server/preview/types.ts'
import type { CapacityRefusal, NavAction, PageState } from './browser-service.ts'

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
  /** Where a dropped or pasted file is on disk (I1); '' when it has none. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** Drives the Dock icon: animated while agents work, badged with how many need you. */
  setActivity: (activity: { working: number; needs: number }): void => ipcRenderer.send('cockpit:activity', activity),
  /** The process runner's open_preview tool reaches the page through this event. */
  onPreviewOpen: (listener: (preview: PreviewOpen) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, value: unknown): void => {
      const preview = value as Partial<PreviewOpen> | undefined
      if (preview && typeof preview.url === 'string' && typeof preview.projectPath === 'string' && (preview.threadId === undefined || typeof preview.threadId === 'string')) listener(preview as PreviewOpen)
    }
    ipcRenderer.on('cockpit:preview-open', receive)
    return () => ipcRenderer.removeListener('cockpit:preview-open', receive)
  },
  /** The in-app browser (wave 9): one page per conversation, drawn by the host over `rect`. */
  browser: {
    open: (key: string, projectPath: string, url: string): Promise<PageState | { error: string } | CapacityRefusal> =>
      ipcRenderer.invoke('cockpit:browser-open', { key, projectPath, url }) as Promise<PageState | { error: string } | CapacityRefusal>,
    /** Where the page goes, in window CSS pixels; null hides it (a menu or dialog needs the space). */
    place: (key: string, rect: { x: number; y: number; width: number; height: number } | null): void => ipcRenderer.send('cockpit:browser-place', { key, rect }),
    navigate: (key: string, action: NavAction): void => ipcRenderer.send('cockpit:browser-nav', { key, action }),
    state: (key: string): Promise<PageState | undefined> => ipcRenderer.invoke('cockpit:browser-state', key) as Promise<PageState | undefined>,
    openExternal: (key: string): void => ipcRenderer.send('cockpit:browser-external', key),
    close: (key: string): void => ipcRenderer.send('cockpit:browser-close', key),
    /** Resolves to an error message, if any. */
    clearData: (projectPath: string): Promise<string | undefined> => ipcRenderer.invoke('cockpit:browser-clear', projectPath) as Promise<string | undefined>,
    onState: (listener: (state: PageState) => void): (() => void) => {
      const receive = (_event: IpcRendererEvent, value: unknown): void => {
        const state = value as Partial<PageState> | undefined
        if (state && typeof state.key === 'string' && typeof state.url === 'string') listener(state as PageState)
      }
      ipcRenderer.on('cockpit:browser-state', receive)
      return () => ipcRenderer.removeListener('cockpit:browser-state', receive)
    },
  },
  copyText: (text: string): void => ipcRenderer.send('cockpit:copy-text', text),
  reportIssue: (report: { kind: 'bug' | 'feedback'; title: string; details: string; includeInfo: boolean }): void => ipcRenderer.send('cockpit:report-issue', report),
  notify: (notification: { threadId: string; title: string; body: string }): void => ipcRenderer.send('cockpit:notify', notification),
  onOpenThread: (listener: (threadId: string) => void): (() => void) => {
    const receive = (_event: IpcRendererEvent, id: unknown): void => { if (typeof id === 'string') listener(id) }
    ipcRenderer.on('cockpit:open-thread', receive)
    return () => ipcRenderer.removeListener('cockpit:open-thread', receive)
  },
  appVersion: (): Promise<string | undefined> => ipcRenderer.invoke('cockpit:app-version') as Promise<string | undefined>,
  /** Crash and error reports: read the answer, or give it (true sends, false never sends). */
  reports: (answer?: boolean): Promise<ReportsStatus | undefined> => ipcRenderer.invoke('cockpit:reports', answer) as Promise<ReportsStatus | undefined>,
  /** An uncaught page error, for a crash report; sent on only after the person said yes. */
  pageError: (error: { message: string; stack?: string }): void => ipcRenderer.send('cockpit:page-error', error),
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
