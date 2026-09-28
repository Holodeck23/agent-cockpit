// Present only inside the desktop app (electron/preload.ts); undefined in a browser.
export interface CockpitBridge {
  readonly platform: string
  pickFolder(): Promise<string | undefined>
  setTheme(mode: 'system' | 'light' | 'dark'): void
  revealTranscript(path: string): void
}

export const native: CockpitBridge | undefined = (window as { cockpit?: CockpitBridge }).cockpit
