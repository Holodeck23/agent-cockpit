import type { NewProject } from '../../electron/new-project.ts'
import type { ReleaseNotes } from '../../electron/updates.ts'

// Present only inside the desktop app (electron/preload.ts); undefined in a browser.
export interface CockpitBridge {
  readonly platform: string
  pickFolder(): Promise<string | undefined>
  /** Name and location in the native Save panel; resolves to the created folder, an error, or undefined if cancelled. */
  newProject(near?: string): Promise<NewProject | undefined>
  setTheme(mode: 'system' | 'light' | 'dark'): void
  revealTranscript(path: string): void
  openFolder(path: string): void
  fileAction(request: { projectPath: string; space: 'project' | 'documents'; path: string; action: 'open' | 'reveal' | 'trash' }): Promise<string | undefined>
  setActivity(activity: { working: number; needs: number }): void
  openPreview(url: string): void
  onPreviewOpen(listener: (url: string) => void): () => void
  copyText(text: string): void
  /** A native notification; clicking it brings Cockpit forward and reports the conversation id. */
  notify(notification: { threadId: string; title: string; body: string }): void
  onOpenThread(listener: (threadId: string) => void): () => void
  appVersion(): Promise<string | undefined>
  /** This version's published notes (untrusted Markdown), from the release feed. */
  releaseNotes(): Promise<ReleaseNotes>
  /** Help → Release Notes was chosen. */
  onShowReleaseNotes(listener: () => void): () => void
  /** Whether the window is in macOS full screen; called on load and on every change. */
  onFullScreen(listener: (fullScreen: boolean) => void): () => void
}

export const native: CockpitBridge | undefined = (window as { cockpit?: CockpitBridge }).cockpit
