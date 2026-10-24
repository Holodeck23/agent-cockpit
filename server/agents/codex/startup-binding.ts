import { lstatSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { codexReviewedThreadConfig } from './startup-review.ts'

const CHANGED = 'Codex native setup changed or could not be checked; review Project Settings. Your message was not delivered.'
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const stable = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) =>
  record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)

// Metadata only: never open config/auth files or copy credential payloads. Native
// layer versions bind parsed config; filesystem identity catches replacement and
// symlink retargeting even when the native semantic version stays the same.
function identity(file: string): string {
  try {
    const link = lstatSync(file, { bigint: true })
    const target = statSync(file, { bigint: true })
    if (!target.isFile()) throw new Error(CHANGED)
    return [realpathSync(file), ...[link, target].flatMap(s =>
      [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String))].join('\0')
  } catch (error) {
    // A missing layer file is valid (stock reports empty system/user layers).
    // A dangling symlink or any unresolved IO is unavailable.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { lstatSync(file) } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      }
    }
    throw new Error(CHANGED)
  }
}

function describe(response: unknown, hostBridge: boolean) {
  codexReviewedThreadConfig(response, hostBridge)
  const layers = (response as { layers: Array<Record<string, unknown>> }).layers
  const files: string[] = []
  const versions = layers.map(layer => {
    if (typeof layer.version !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(layer.version)) throw new Error(CHANGED)
    const name = layer.name as Record<string, unknown>
    if (name.type === 'project') files.push(join(String(name.dotCodexFolder ?? name.dot_codex_folder), 'config.toml'))
    else if (typeof name.file === 'string') files.push(name.file)
    const disabled = layer.disabledReason ?? layer.disabled_reason ?? null
    if (disabled !== null && typeof disabled !== 'string') throw new Error(CHANGED)
    return { name, version: layer.version, disabled }
  })
  return { versions: stable(versions), files: new Map(files.map(file => [file, identity(file)])) }
}

/** Point-in-time binding, not an atomic loader lock or a cloud-policy guarantee. */
export function bindCodexStartup(response: unknown, hostBridge: boolean) {
  const initial = describe(response, hostBridge)
  const checkFiles = (): void => {
    for (const [file, expected] of initial.files) if (identity(file) !== expected) throw new Error(CHANGED)
  }
  return {
    checkFiles,
    recheck(current: unknown): void {
      const next = describe(current, hostBridge)
      if (next.versions !== initial.versions) throw new Error(CHANGED)
      checkFiles()
      for (const [file, expected] of initial.files) if (next.files.get(file) !== expected) throw new Error(CHANGED)
    },
  }
}
