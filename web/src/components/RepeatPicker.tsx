import type { RepeatChoice, RepeatKind } from '../repeat.ts'

// The workflow editor's Repeat field: never, every N minutes, or days of the week at a local time.

const KINDS: { id: RepeatKind; label: string }[] = [
  { id: 'never', label: 'Never (run by hand)' },
  { id: 'interval', label: 'Every few minutes' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { id: 'weekly', label: 'On chosen days' },
]
// Monday first, as a week reads; values stay 0 = Sunday.
const DAYS = [{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }, { d: 5, l: 'Fri' }, { d: 6, l: 'Sat' }, { d: 0, l: 'Sun' }]

export function RepeatPicker({ value, onChange }: { value: RepeatChoice; onChange: (next: RepeatChoice) => void }) {
  const set = (patch: Partial<RepeatChoice>): void => onChange({ ...value, ...patch })
  const toggleDay = (day: number): void =>
    set({ days: value.days.includes(day) ? value.days.filter((d) => d !== day) : [...value.days, day].sort((a, b) => a - b) })
  const calendar = value.kind === 'daily' || value.kind === 'weekdays' || value.kind === 'weekly'

  return (
    <div className="repeat-picker">
      <label>Repeat
        <select aria-label="Repeat" value={value.kind} onChange={(e) => set({ kind: e.target.value as RepeatKind })}>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </label>
      {value.kind === 'interval' ? (
        <label>Every (minutes)
          <input aria-label="Every (minutes)" type="number" min={5} max={43200} step={1} value={value.minutes} onChange={(e) => set({ minutes: e.target.value })} placeholder="60" />
        </label>
      ) : null}
      {value.kind === 'weekly' ? (
        <div className="repeat-days" role="group" aria-label="Days">
          {DAYS.map(({ d, l }) => (
            <button key={d} type="button" aria-pressed={value.days.includes(d)} onClick={() => toggleDay(d)}>{l}</button>
          ))}
        </div>
      ) : null}
      {calendar ? (
        <label>At
          <input aria-label="At" type="time" required value={value.time} onChange={(e) => set({ time: e.target.value })} />
        </label>
      ) : null}
      {calendar ? <small>Times are in {value.timeZone}. When the clocks change, it keeps the same local time.</small> : null}
    </div>
  )
}
