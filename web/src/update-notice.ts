// After Cockpit is replaced by a newer version, the first launch says so once and offers the
// notes. The page remembers the last version it ran; nothing is fetched until asked.
import semver from 'semver'

const KEY = 'cockpit:last-version'

export function updateNotice(previous: string | undefined, current: string): string | undefined {
  if (!previous || !semver.valid(previous) || !semver.valid(current)) return undefined
  return semver.gt(current, previous) ? `Updated to Cockpit ${current}` : undefined
}

/** Records the running version and resolves to the notice to show, if any. Desktop only. */
export async function checkForUpdateNotice(appVersion: () => Promise<string | undefined>): Promise<string | undefined> {
  const current = await appVersion().catch(() => undefined)
  if (!current) return undefined
  let previous: string | undefined
  try {
    previous = localStorage.getItem(KEY) ?? undefined
    localStorage.setItem(KEY, current)
  } catch {
    return undefined
  }
  return updateNotice(previous, current)
}
