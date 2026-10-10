// Optional sounds: one when an agent finishes replying, one when it needs a decision. Both off
// by default and kept per device. The tones are synthesised here (Web Audio), no sound files.
import { useEffect, useRef, useState } from 'react'
import type { ThreadSummary } from './api.ts'
import { isWorking } from './conversation-meta.ts'

export type SoundKind = 'reply' | 'decision'
export interface SoundSettings {
  readonly reply: boolean
  readonly decision: boolean
}
export const DEFAULT_SOUNDS: SoundSettings = { reply: false, decision: false }
const KEY = 'cockpit:sounds'

export function parseSounds(raw: string | null): SoundSettings {
  try {
    const stored: unknown = raw ? JSON.parse(raw) : {}
    const s = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
    return { reply: s.reply === true, decision: s.decision === true }
  } catch {
    return DEFAULT_SOUNDS
  }
}

type Row = Pick<ThreadSummary, 'status' | 'lastActivityAt' | 'awaiting'> & { meta: Pick<ThreadSummary['meta'], 'id'> }
export type Seen = ReadonlyMap<string, Pick<Row, 'status' | 'lastActivityAt'>>
// A question or blocker at the end of a turn waits on you just like an approval (U12).
const effective = (t: Row): Row['status'] => (t.awaiting && !isWorking(t.status) ? 'needs_input' : t.status)
const ENDED = new Set<Row['status']>(['done', 'idle'])

export interface AttentionChange {
  readonly id: string
  readonly kind: SoundKind
}

/**
 * Conversations that now call for you, one entry each, in list order. Answering one approval can
 * surface the next at once, so the list may never show "working" in between:
 *  - decision: a conversation that is now waiting and either wasn't before, or has new activity
 *    since (a fresh approval), or is new since the last update;
 *  - reply: a turn that ended (done or idle) after working or waiting.
 * `previous` is undefined on the first look, which reports nothing. `focusedId` is the
 * conversation you are looking at (open, window focused): it never calls for you.
 */
export function attentionChanges(previous: Seen | undefined, threads: readonly Row[], focusedId?: string): AttentionChange[] {
  if (!previous) return []
  const changes: AttentionChange[] = []
  for (const t of threads) {
    if (t.meta.id === focusedId) continue
    const before = previous.get(t.meta.id)
    const status = effective(t)
    if (status === 'needs_input' && (before?.status !== 'needs_input' || before.lastActivityAt !== t.lastActivityAt)) changes.push({ id: t.meta.id, kind: 'decision' })
    else if (before && ENDED.has(status) && (isWorking(before.status) || before.status === 'needs_input')) changes.push({ id: t.meta.id, kind: 'reply' })
  }
  return changes
}

/** Which sound a change calls for, if any; at most one per update, a decision first. */
export function soundFor(previous: Seen | undefined, threads: readonly Row[], settings: SoundSettings, focusedId?: string): SoundKind | undefined {
  return soundForChanges(attentionChanges(previous, threads, focusedId), settings)
}

// Lumen's chimes: small glass bells. Each note is a sine with two quiet inharmonic partials (the
// ratios of a struck bell) that fade faster than the note, so it rings and then settles; a faint
// echo gives it room. Reply rises a fifth; a decision is a three-note call, brighter but not loud.
const TONES: Record<SoundKind, { notes: ReadonlyArray<[frequency: number, start: number]> }> = {
  reply: { notes: [[880, 0], [1318.51, 0.12]] },
  decision: { notes: [[1108.73, 0], [1318.51, 0.13], [1760, 0.26]] },
}
const PARTIALS: ReadonlyArray<[ratio: number, gain: number, decay: number]> = [[1, 0.13, 1.3], [2.76, 0.03, 0.45], [5.4, 0.01, 0.2]]
let context: AudioContext | undefined
let room: AudioNode | undefined

/** A quiet feedback echo every note passes through once: the room the bells ring in. */
function roomFor(ctx: AudioContext): AudioNode {
  const input = ctx.createGain()
  const delay = ctx.createDelay(1)
  const feedback = ctx.createGain()
  const wet = ctx.createGain()
  delay.delayTime.value = 0.19
  feedback.gain.value = 0.28
  wet.gain.value = 0.22
  input.connect(ctx.destination)
  input.connect(delay).connect(feedback).connect(delay)
  delay.connect(wet).connect(ctx.destination)
  return input
}

/** Plays the tone and announces it (`cockpit:sound` on window), which is how the proofs hear it. */
export function playSound(kind: SoundKind): void {
  window.dispatchEvent(new CustomEvent('cockpit:sound', { detail: kind }))
  try {
    context ??= new AudioContext()
    room ??= roomFor(context)
    void context.resume()
    for (const [frequency, start] of TONES[kind].notes) {
      const at = context.currentTime + start
      for (const [ratio, peak, decay] of PARTIALS) {
        const osc = context.createOscillator()
        const gain = context.createGain()
        osc.type = 'sine'
        osc.frequency.value = frequency * ratio
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
        osc.connect(gain).connect(room)
        osc.start(at)
        osc.stop(at + decay + 0.02)
      }
    }
  } catch {
    // no audio output available: stay quiet
  }
}

export function useSoundSettings(): { sounds: SoundSettings; setSounds: (next: SoundSettings) => void } {
  const [sounds, setSounds] = useState<SoundSettings>(() => {
    try {
      return parseSounds(localStorage.getItem(KEY))
    } catch {
      return DEFAULT_SOUNDS
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sounds))
    } catch {
      // not persisted
    }
  }, [sounds])
  return { sounds, setSounds }
}

/**
 * Watches conversation statuses and reports what now calls for you (see attentionChanges).
 * `focused` is read at each update: the conversation you are looking at, if any.
 */
export function useAttention(threads: readonly ThreadSummary[], focused: () => string | undefined, onChanges: (changes: AttentionChange[]) => void): void {
  const seen = useRef<Seen>(undefined)
  const handler = useRef(onChanges)
  handler.current = onChanges
  const focus = useRef(focused)
  focus.current = focused
  useEffect(() => {
    const changes = attentionChanges(seen.current, threads, focus.current())
    seen.current = new Map(threads.map((t) => [t.meta.id, { status: effective(t), lastActivityAt: t.lastActivityAt }]))
    if (changes.length > 0) handler.current(changes)
  }, [threads])
}

/** The sound for a set of changes under the current settings: a decision first. */
export function soundForChanges(changes: readonly AttentionChange[], settings: SoundSettings): SoundKind | undefined {
  if (settings.decision && changes.some((c) => c.kind === 'decision')) return 'decision'
  if (settings.reply && changes.some((c) => c.kind === 'reply')) return 'reply'
  return undefined
}
