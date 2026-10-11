import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../files/atomic.ts'
import { join } from 'node:path'
import { z } from 'zod'
import { ALL_EFFORTS, PERMISSION_MODES } from '../agents/claude/flags.ts'

// <root>/presets.json: named agent settings (agent, model, effort, permissions), one click to
// apply in the agent picker. Shared by every window and the phone; edited on the Mac.

const AGENTS = ['claude', 'codex', 'antigravity', 'opencode'] as const
const ANTIGRAVITY_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'manual', 'plan'])

export const presetSchema = z.object({
  name: z.string().trim().min(1).max(40),
  agent: z.enum(AGENTS),
  model: z.string().trim().max(200),
  effort: z.union([z.literal(''), z.enum(ALL_EFFORTS)]),
  permissionMode: z.enum(PERMISSION_MODES),
})
export type Preset = z.output<typeof presetSchema>
const MAX_PRESETS = 30
export const presetListSchema = z.array(presetSchema).max(MAX_PRESETS)

export interface PresetStore {
  list(): Preset[]
  /** Replaces the whole list (the picker edits it as one); throws on an invalid list. A file that held anything list() could not read is copied aside first. */
  replace(presets: readonly unknown[]): Preset[]
}

export function createPresetStore(root: string): PresetStore {
  const file = join(root, 'presets.json')
  // Entries are checked one by one, so one stale or hand-mangled preset hides only itself.
  // `whole` is false when the file held anything that was dropped.
  const load = (): { presets: Preset[]; whole: boolean } => {
    try {
      if (!existsSync(file)) return { presets: [], whole: true }
      const rows = (JSON.parse(readFileSync(file, 'utf8')) as { presets?: unknown } | null)?.presets ?? []
      if (!Array.isArray(rows)) return { presets: [], whole: false }
      const valid = rows.flatMap((row) => {
        const parsed = presetSchema.safeParse(row)
        return parsed.success ? [parsed.data] : []
      })
      const presets = valid.slice(0, MAX_PRESETS)
      return { presets, whole: presets.length === rows.length }
    } catch {
      return { presets: [], whole: false }
    }
  }
  return {
    list: () => load().presets,
    replace(input) {
      const presets = presetListSchema.parse(input)
      const seen = new Set<string>()
      for (const preset of presets) {
        const key = preset.name.toLowerCase()
        if (seen.has(key)) throw new Error(`A preset called “${preset.name}” already exists`)
        seen.add(key)
        if (preset.agent === 'antigravity' && !ANTIGRAVITY_MODES.has(preset.permissionMode)) {
          throw new Error('Antigravity presets can bypass permissions, use its own settings, or plan')
        }
      }
      mkdirSync(root, { recursive: true })
      // The picker saves list() plus its change, so whatever list() dropped would be gone for good: keep the old file.
      if (!load().whole) copyFileSync(file, `${file}.${Date.now()}.bak`)
      writeFileAtomic(file, `${JSON.stringify({ presets }, null, 2)}
`)
      return presets
    },
  }
}
