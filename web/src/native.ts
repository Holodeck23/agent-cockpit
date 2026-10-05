import type { NewProject } from '../../electron/new-project.ts'
import type { ReleaseNotes } from '../../electron/updates.ts'
import type { PreviewOpen } from '../../server/preview/types.ts'

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

// No window at all where the page's modules load under Node (tests that render to a string).
export const native: CockpitBridge | undefined = typeof window === 'undefined' ? undefined : (window as { cockpit?: CockpitBridge }).cockpit
