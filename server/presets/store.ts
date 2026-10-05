import { existsSync, mkdirSync, readFileSync } from 'node:fs'
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
export const presetListSchema = z.array(presetSchema).max(30)

export interface PresetStore {
  list(): Preset[]
  /** Replaces the whole list (the picker edits it as one); throws on an invalid list. */
  replace(presets: readonly unknown[]): Preset[]
}

export function createPresetStore(root: string): PresetStore {
  const file = join(root, 'presets.json')
  const read = (): Preset[] => {
    try {
      return existsSync(file) ? presetListSchema.parse((JSON.parse(readFileSync(file, 'utf8')) as { presets?: unknown }).presets ?? []) : []
    } catch {
      return []
    }
  }
  return {
    list: read,
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
      writeFileAtomic(file, `${JSON.stringify({ presets }, null, 2)}
`)
      return presets
    },
  }
}
