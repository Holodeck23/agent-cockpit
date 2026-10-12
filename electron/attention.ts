// Native attention for a fresh approval or question. Kept outside main.ts so the Dock/window
// behavior is testable without booting Electron.

interface AttentionDock {
  bounce(type: 'critical'): unknown
}

interface AttentionWindow {
  isDestroyed(): boolean
  flashFrame(flag: boolean): void
}

export function requestNativeAttention(dock: AttentionDock | undefined, window: AttentionWindow | undefined): void {
  dock?.bounce('critical')
  if (window && !window.isDestroyed()) window.flashFrame(true)
}
