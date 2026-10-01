// The Dock icon tells you what the agents are doing without opening the window: its bars move
// while any agent is working (four frames a second, stopped the moment nothing is), and its badge
// shows how many conversations need you. Frames come from build/dock (scripts/make-dock-frames.ts).

export interface Activity {
  readonly working: number
  readonly needs: number
}

interface DockDeps<Image> {
  readonly frames: readonly Image[]
  readonly rest: Image
  setIcon(image: Image): void
  setBadge(text: string): void
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const FRAME_MS = 250

/** Accepts only what the page may send: two small non-negative integers. */
export function parseActivity(value: unknown): Activity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { working, needs } = value as Record<string, unknown>
  const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 10_000
  return count(working) && count(needs) ? { working, needs } : undefined
}

export function createDockActivity<Image>(deps: DockDeps<Image>): { update(activity: Activity): void; stop(): void } {
  let timer: unknown
  let frame = 0
  let badge = ''
  const stopAnimation = (): void => {
    if (timer === undefined) return
    deps.clearInterval(timer)
    timer = undefined
    deps.setIcon(deps.rest)
  }
  return {
    update({ working, needs }) {
      const nextBadge = needs > 0 ? String(needs) : ''
      if (nextBadge !== badge) deps.setBadge((badge = nextBadge))
      if (working > 0 && timer === undefined && deps.frames.length > 0) {
        frame = 0
        deps.setIcon(deps.frames[0]!)
        timer = deps.setInterval(() => {
          frame = (frame + 1) % deps.frames.length
          deps.setIcon(deps.frames[frame]!)
        }, FRAME_MS)
      } else if (working === 0) stopAnimation()
    },
    stop() {
      stopAnimation()
      if (badge) deps.setBadge((badge = ''))
    },
  }
}
