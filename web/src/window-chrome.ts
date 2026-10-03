// The tab bar starts after the Mac's window buttons. They don't scale with page zoom and they
// hide in full screen, so the clearance follows both instead of being a fixed 84px.
import type { CockpitBridge } from './native.ts'

const BUTTONS = 84
const EDGE = 16

/** CSS pixels to leave clear at the tab bar's left edge. */
export function trafficClearance(fullScreen: boolean, outerWidth: number, innerWidth: number): number {
  if (fullScreen) return EDGE
  const zoom = outerWidth > 0 && innerWidth > 0 ? outerWidth / innerWidth : 1
  return Math.round(BUTTONS / zoom)
}

/** Keeps --traffic-clearance current in the desktop app. */
export function trackWindowChrome(bridge: CockpitBridge): void {
  let fullScreen = false
  const apply = (): void => {
    const px = trafficClearance(fullScreen, window.outerWidth, window.innerWidth)
    document.documentElement.style.setProperty('--traffic-clearance', `${px}px`)
  }
  // Zooming changes the page's width in CSS pixels, which fires resize.
  window.addEventListener('resize', apply)
  bridge.onFullScreen((value) => { fullScreen = value; apply() })
  apply()
}
