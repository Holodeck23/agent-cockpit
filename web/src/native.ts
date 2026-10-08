import type { NewProject } from '../../electron/new-project.ts'
import type { ReleaseNotes } from '../../electron/updates.ts'
import type { PreviewOpen } from '../../server/preview/types.ts'
import type { CapacityRefusal, NavAction, PageState } from '../../electron/browser-service.ts'

export type BrowserPageState = PageState
export type BrowserCapacity = CapacityRefusal['capacity']

// Present only inside the desktop app (electron/preload.ts); undefined in a browser.
export interface CockpitBridge {
  readonly platform: string
  pickFolder(): Promise<string | undefined>
  /** Name and location in the native Save panel; resolves to the created folder, an error, or undefined if cancelled. */
  newProject(near?: string): Promise<NewProject | undefined>
  setTheme(mode: 'system' | 'light' | 'dark'): void
  revealTranscript(path: string): void
  openFolder(path: string): void
  copyInto(request: { projectPath: string; space: 'project' | 'documents'; folder: string; files: readonly File[] }): Promise<
    { copied: string[]; skipped: Array<{ name: string; reason: string }> } | { error: string }>
  /** Where a dropped or pasted file is on disk; '' when it has none (a pasted screenshot). */
  pathForFile(file: File): string
  fileAction(request: { projectPath: string; space: 'project' | 'documents'; path: string; action: 'open' | 'reveal' | 'trash' }): Promise<string | undefined>
  setActivity(activity: { working: number; needs: number }): void
  onPreviewOpen(listener: (preview: PreviewOpen) => void): () => void
  copyText(text: string): void
  /** Report a bug / Send feedback: opens a filled-in GitHub issue in the browser; the Mac's details are added here only when asked. */
  reportIssue?(report: { kind: 'bug' | 'feedback'; title: string; details: string; includeInfo: boolean }): void
  /** A native notification; clicking it brings Cockpit forward and reports the conversation id. */
  notify(notification: { threadId: string; title: string; body: string }): void
  onOpenThread(listener: (threadId: string) => void): () => void
  appVersion(): Promise<string | undefined>
  /** Crash and error reports (on by default): read the setting, or change it. Absent in builds before 0.1.6. */
  reports?(on?: boolean): Promise<{ available: boolean; reports: boolean } | undefined>
  /** An uncaught page error, for a crash report (dropped when reports are turned off). */
  pageError?(error: { message: string; stack?: string }): void
  /** This version's published notes (untrusted Markdown), from the release feed. */
  releaseNotes(): Promise<ReleaseNotes>
  /** Help → Release Notes was chosen. */
  onShowReleaseNotes(listener: () => void): () => void
  /** Whether the window is in macOS full screen; called on load and on every change. */
  onFullScreen(listener: (fullScreen: boolean) => void): () => void
  /** The in-app browser (wave 9); absent in older desktop builds and in a plain browser. */
  readonly browser?: {
    open(key: string, projectPath: string, url: string): Promise<PageState | { error: string } | CapacityRefusal>
    place(key: string, rect: { x: number; y: number; width: number; height: number } | null): void
    navigate(key: string, action: NavAction): void
    state(key: string): Promise<PageState | undefined>
    openExternal(key: string): void
    close(key: string): void
    clearData(projectPath: string): Promise<string | undefined>
    onState(listener: (state: PageState) => void): () => void
  }
}

// No window at all where the page's modules load under Node (tests that render to a string).
export const native: CockpitBridge | undefined = typeof window === 'undefined' ? undefined : (window as { cockpit?: CockpitBridge }).cockpit
