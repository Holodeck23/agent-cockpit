// Present only inside the desktop app (electron/preload.ts); undefined in a browser.
export interface CockpitBridge {
  readonly platform: string
  pickFolder(): Promise<string | undefined>
}

export const native: CockpitBridge | undefined = (window as { cockpit?: CockpitBridge }).cockpit
