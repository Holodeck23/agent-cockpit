// A state file Cockpit cannot read safely. Its bytes are left exactly as found and nothing writes
// over it until it is repaired; the operations that need it fail with this message instead.

export type StoreReadCode = 'UNREADABLE' | 'FUTURE_VERSION'

export class StoreReadError extends Error {
  constructor(
    readonly code: StoreReadCode,
    readonly file: string,
    detail?: string,
  ) {
    super(
      code === 'FUTURE_VERSION'
        ? `${file} was written by a newer Cockpit. It has been left untouched; update Cockpit to use it.`
        : `Cockpit cannot read ${file}${detail ? ` (${detail})` : ''}. The original file has been preserved; repair it or move it aside, then try again.`,
    )
  }
}
