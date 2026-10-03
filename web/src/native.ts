// Present only inside the desktop app (electron/preload.ts); undefined in a browser.
export interface CockpitBridge {
  readonly platform: string
  pickFolder(): Promise<string | undefined>
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
}

export const native: CockpitBridge | undefined = (window as { cockpit?: CockpitBridge }).cockpit
