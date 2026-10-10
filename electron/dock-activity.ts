// The Dock icon tells you what the agents are doing without opening the window: its moon circles
// the light while any agent is working (one orbit in 2.4 s, stopped the moment nothing is), and its
// badge shows how many conversations need you. Frames come from build/dock (scripts/make-dock-frames.ts).

export interface Activity {
  readonly working: number
  readonly needs: number
}

interface DockDeps<Image> {
  readonly frames: readonly Image[]
  readonly rest: Image
  /** The dark-appearance set; without it the light one is used in both. */
  readonly dark?: { readonly frames: readonly Image[]; readonly rest: Image }
  setIcon(image: Image): void
  setBadge(text: string): void
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** Frames in one orbit, and how long each shows: 24 × 100 ms is one orbit in 2.4 s. */
export const DOCK_FRAMES = 24
export const FRAME_MS = 100

/** Accepts only what the page may send: two small non-negative integers. */
export function parseActivity(value: unknown): Activity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { working, needs } = value as Record<string, unknown>
  const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 10_000
  return count(working) && count(needs) ? { working, needs } : undefined
}

export function createDockActivity<Image>(deps: DockDeps<Image>): { update(activity: Activity): void; setDark(dark: boolean): void; stop(): void } {
  let timer: unknown
  let frame = 0
  let badge = ''
  let dark = false
  const look = (): { readonly frames: readonly Image[]; readonly rest: Image } => (dark && deps.dark ? deps.dark : deps)
  const stopAnimation = (): void => {
    if (timer === undefined) return
    deps.clearInterval(timer)
    timer = undefined
    deps.setIcon(look().rest)
  }
  return {
    update({ working, needs }) {
      const nextBadge = needs > 0 ? String(needs) : ''
      if (nextBadge !== badge) deps.setBadge((badge = nextBadge))
      if (working > 0 && timer === undefined && look().frames.length > 0) {
        frame = 0
        deps.setIcon(look().frames[0]!)
        timer = deps.setInterval(() => {
          const { frames } = look()
          frame = (frame + 1) % frames.length
          deps.setIcon(frames[frame]!)
        }, FRAME_MS)
      } else if (working === 0) stopAnimation()
    },
    /** Follows the app's appearance; a running animation carries on in the new look. */
    setDark(next) {
      if (next === dark) return
      dark = next
      if (timer === undefined) deps.setIcon(look().rest)
    },
    stop() {
      stopAnimation()
      if (badge) deps.setBadge((badge = ''))
    },
  }
}
