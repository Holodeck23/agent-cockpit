// Project files pinned to the navigation: a short ordered list of relative paths.
// Pure helpers, unit-tested; the list itself lives on the project (server/projects/store.ts).

/** Pins at the end, or unpins if already there. */
export const togglePin = (pins: readonly string[], path: string): string[] =>
  pins.includes(path) ? pins.filter((p) => p !== path) : [...pins, path]

/** A renamed file keeps its place among the pins. */
export const renamePin = (pins: readonly string[], from: string, to: string): string[] =>
  pins.map((p) => (p === from ? to : p))

export const dropPin = (pins: readonly string[], path: string): string[] => pins.filter((p) => p !== path)
