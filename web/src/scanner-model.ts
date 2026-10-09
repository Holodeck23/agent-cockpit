// D12 scanner model: where every lamp is bright, and when. The CSS in styles/scanner.css is the
// renderer (opacity keyframes with per-lamp delays); this is the same arithmetic in plain numbers,
// used to give each lamp its start time and, in proof:scanner, to check what the page really draws.
//
// Times are % of one cycle (--scanner-cycle, 5.2 s). The head crosses the lamp row in 45%, holds on
// the end lamp while the tail is drawn into it for 5%, comes back in 45%, and does it again.

export const LAMPS = 73
/** One lamp step: the head crosses LAMPS - 1 gaps in 45% of the cycle (0.625% = 32 ms). */
export const STEP = 45 / (LAMPS - 1)
/** A lamp reaches its peak this long after it starts to light (1.25% = 65 ms). */
export const RISE = 1.25
/** From its peak a lamp's red streak falls to dark over this (14% = 0.73 s), so the streak is about 22 lamps. */
export const DECAY = 14
/** The shape of the fall: 1 is a straight line down, higher drops faster at first. */
export const FALL = 1.6
/** The tail is drawn into the end lamp over this (5% = 260 ms), then the head goes back the other way. */
export const CONTRACT = 5
/** How bright the streak is at the head, and in the end lamp as the tail is drawn into it. */
export const PEAK = 0.55
export const END_PEAK = 0.7
/** The glowing core: much brighter than the streak, and gone within this (5% = 0.26 s, about 8 lamps). */
export const CORE_PEAK = 1
export const CORE_DECAY = 5
export const CORE_FALL = 2.2
/** Lamps behind the end lamp that are still lit when the head gets there, nearest first: 1 … TAIL. */
export const TAIL = Math.ceil(DECAY / STEP) - 1
/** After a cut a lamp stays out this long (past its whole fall) before it can be lit again. */
export const CUT_HOLD = 16

export const RIGHT_END = 45
export const LEFT_END = 95

export type Row = 'fwd' | 'rev'
export interface LampPlan {
  readonly row: Row
  readonly lamp: number
  /** 'end': the end lamp, one longer flash through the contraction. 'dead': this row never lights it. */
  readonly kind: 'flash' | 'end' | 'dead'
  /** When the lamp starts to light, as a fraction of the cycle (negative: before the cycle's start). */
  readonly at: number
  /** When the contraction puts the lamp out, as a fraction of the cycle; absent if it is not cut. */
  readonly cut?: number
}

/** When the contraction starts putting out the lamp m places behind an end lamp: farthest first. */
export const cutTime = (m: number, end: number): number => end + ((TAIL - m) / (TAIL - 1)) * (CONTRACT - STEP)

/** The two rows of lamps, in lamp order: `fwd` lights going right, `rev` going left. */
export function plan(row: Row): LampPlan[] {
  return Array.from({ length: LAMPS }, (_, lamp) => {
    const last = LAMPS - 1
    if (row === 'fwd') {
      if (lamp === 0) return { row, lamp, kind: 'dead', at: 0 }
      if (lamp === last) return { row, lamp, kind: 'end', at: (RIGHT_END - RISE) / 100 }
      const m = last - lamp
      return { row, lamp, kind: 'flash', at: (lamp * STEP - RISE) / 100, ...(m <= TAIL ? { cut: cutTime(m, RIGHT_END) / 100 } : {}) }
    }
    if (lamp === last) return { row, lamp, kind: 'dead', at: 0 }
    if (lamp === 0) return { row, lamp, kind: 'end', at: (LEFT_END - RISE) / 100 }
    return { row, lamp, kind: 'flash', at: (LEFT_END - lamp * STEP - RISE) / 100, ...(lamp <= TAIL ? { cut: cutTime(lamp, LEFT_END) / 100 } : {}) }
  })
}

const wrap = (t: number): number => ((t % 100) + 100) % 100
const fall = (delta: number): number => (delta < DECAY ? (1 - delta / DECAY) ** FALL : 0)

/** A lamp's own flash, `delta` % after its peak. */
function flash(delta: number): number {
  if (delta < -RISE) return 0
  if (delta < 0) return PEAK * (1 + delta / RISE)
  return PEAK * fall(delta)
}
/** An end lamp: the head arrives at 0, the tail collapses into it by CONTRACT, then it is the new tail's first lamp. */
function endFlash(delta: number): number {
  if (delta < -RISE) return 0
  if (delta < 0) return PEAK * (1 + delta / RISE)
  if (delta < CONTRACT) return PEAK + ((END_PEAK - PEAK) * delta) / CONTRACT
  return END_PEAK * fall(delta - CONTRACT)
}
/** 1 until the contraction puts the lamp out (within one step), 0 through its fall, then back to 1. */
function cutFactor(since: number): number {
  if (since < STEP) return 1 - since / STEP
  if (since < CUT_HOLD) return 0
  if (since < CUT_HOLD + STEP) return (since - CUT_HOLD) / STEP
  return 1
}

/** The red light of one lamp of one row at `t` (% of the cycle). */
export function level(p: LampPlan, t: number): number {
  if (p.kind === 'dead') return 0
  const since = wrap(t - p.at * 100) // % after the lamp started to light
  const delta = since - RISE // % after its peak (negative while rising)
  const base = p.kind === 'end' ? endFlash(delta > 50 ? delta - 100 : delta) : flash(delta > 50 ? delta - 100 : delta)
  const cut = p.cut === undefined ? 1 : cutFactor(wrap(t - p.cut * 100))
  return base * cut
}

function coreFlash(delta: number, kind: LampPlan['kind']): number {
  if (delta < -RISE) return 0
  if (delta < 0) return CORE_PEAK * (1 + delta / RISE)
  const hold = kind === 'end' ? CONTRACT : 0 // an end lamp's core stays full while the tail is drawn into it
  if (delta < hold) return CORE_PEAK
  const d = delta - hold
  return d < CORE_DECAY ? CORE_PEAK * (1 - d / CORE_DECAY) ** CORE_FALL : 0
}

/** The glowing core of one lamp of one row at `t` (% of the cycle). */
export function coreLevel(p: LampPlan, t: number): number {
  if (p.kind === 'dead') return 0
  const delta = wrap(t - p.at * 100) - RISE
  const base = coreFlash(delta > 50 ? delta - 100 : delta, p.kind)
  return base * (p.cut === undefined ? 1 : cutFactor(wrap(t - p.cut * 100)))
}

/** How bright each lamp's core is at `t`. */
export function coreLevels(t: number): number[] {
  const f = plan('fwd')
  const r = plan('rev')
  return Array.from({ length: LAMPS }, (_, lamp) => Math.max(coreLevel(f[lamp]!, t), coreLevel(r[lamp]!, t)))
}

/** How bright each lamp's red streak is at `t`: the brighter of its two passes. */
export function levels(t: number): number[] {
  const f = plan('fwd')
  const r = plan('rev')
  return Array.from({ length: LAMPS }, (_, lamp) => Math.max(level(f[lamp]!, t), level(r[lamp]!, t)))
}
