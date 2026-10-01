// Optional sounds: one when an agent finishes replying, one when it needs a decision. Both off
// by default and kept per device. The tones are synthesised here (Web Audio), no sound files.
import { useEffect, useRef, useState } from 'react'
import type { ThreadSummary } from './api.ts'

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

type Row = Pick<ThreadSummary, 'status' | 'lastActivityAt'> & { meta: Pick<ThreadSummary['meta'], 'id'> }
export type Seen = ReadonlyMap<string, Pick<Row, 'status' | 'lastActivityAt'>>
const ENDED = new Set<Row['status']>(['done', 'idle'])

/**
 * Which sound a change calls for, if any; at most one per update, a decision first. Answering one
 * approval can surface the next at once, so the list may never show "working" in between:
 *  - decision: a conversation that is now waiting and either wasn't before, or has new activity
 *    since (a fresh approval), or is new since the last update;
 *  - reply: a turn that ended (done or idle) after working or waiting.
 * `previous` is undefined on the first look, which never sounds.
 */
export function soundFor(previous: Seen | undefined, threads: readonly Row[], settings: SoundSettings): SoundKind | undefined {
  if (!previous) return undefined
  let reply = false
  for (const t of threads) {
    const before = previous.get(t.meta.id)
    const waiting = t.status === 'needs_input' && (before?.status !== 'needs_input' || before.lastActivityAt !== t.lastActivityAt)
    if (waiting && settings.decision) return 'decision'
    if (before && ENDED.has(t.status) && (before.status === 'working' || before.status === 'needs_input')) reply = true
  }
  return reply && settings.reply ? 'reply' : undefined
}

const TONES: Record<SoundKind, { type: OscillatorType; notes: ReadonlyArray<[frequency: number, start: number]> }> = {
  reply: { type: 'sine', notes: [[659.25, 0], [880, 0.11]] },
  decision: { type: 'triangle', notes: [[880, 0], [880, 0.14], [1318.5, 0.28]] },
}
let context: AudioContext | undefined

/** Plays the tone and announces it (`cockpit:sound` on window), which is how the proofs hear it. */
export function playSound(kind: SoundKind): void {
  window.dispatchEvent(new CustomEvent('cockpit:sound', { detail: kind }))
  try {
    context ??= new AudioContext()
    void context.resume()
    const { type, notes } = TONES[kind]
    for (const [frequency, start] of notes) {
      const at = context.currentTime + start
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = type
      osc.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32)
      osc.connect(gain).connect(context.destination)
      osc.start(at)
      osc.stop(at + 0.34)
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

/** Watches conversation statuses and plays the matching sound when one is switched on. */
export function useStatusSounds(threads: readonly ThreadSummary[], settings: SoundSettings): void {
  const seen = useRef<Seen>(undefined)
  useEffect(() => {
    const kind = soundFor(seen.current, threads, settings)
    seen.current = new Map(threads.map((t) => [t.meta.id, { status: t.status, lastActivityAt: t.lastActivityAt }]))
    if (kind) playSound(kind)
  }, [threads, settings])
}
