// A project's choice to load the user's own skills, commands and agents (W13 U6), bound to the
// destination account generation and the exact revision reviewed. A changed source asks for a fresh
// review instead of loading content nobody looked at; a projection is never edited after it is made.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ensurePrivateDir, writeFileAtomic } from '../../files/atomic.ts'
import { StoreReadError } from '../../state/read-error.ts'
import { materializeSkillProjection, snapshotSkillSource } from './skill-projection.ts'

const selectionSchema = z.object({
  id: z.uuid(),
  projectPath: z.string().refine(isAbsolute),
  destinationAccountId: z.string().min(1),
  destinationGeneration: z.number().int().min(1),
  sourceAccountId: z.string().min(1),
  sourceProfileDir: z.string().refine(isAbsolute),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.object({ skills: z.number().int().min(0), commands: z.number().int().min(0), agents: z.number().int().min(0), excluded: z.number().int().min(0) }),
  selectedAt: z.iso.datetime(),
})
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), selections: z.array(selectionSchema) })
export type SkillSelection = z.output<typeof selectionSchema>

export interface SkillSelectionStore {
  select(input: Pick<SkillSelection, 'projectPath' | 'destinationAccountId' | 'destinationGeneration' | 'sourceAccountId' | 'sourceProfileDir'>,
    expectedSelectionId?: string): SkillSelection
  get(projectPath: string): SkillSelection | undefined
  revoke(projectPath: string, expectedSelectionId: string): boolean
}

export function createSkillSelectionStore(root: string): SkillSelectionStore {
  const file = join(root, 'skill-selections.json')
  const read = (): z.output<typeof fileSchema> => {
    if (!existsSync(file)) return { version: 1, revision: 0, selections: [] }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new StoreReadError('UNREADABLE', file, 'not valid JSON') }
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) throw new StoreReadError('UNREADABLE', file, 'unexpected format')
    return parsed.data
  }
  const write = (next: z.output<typeof fileSchema>): void => { ensurePrivateDir(root); writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`) }
  const get = (projectPath: string): SkillSelection | undefined => read().selections.find((row) => row.projectPath === projectPath)
  return {
    get,
    select(input, expectedSelectionId) {
      const source = snapshotSkillSource(input.sourceProfileDir)
      const current = read()
      if (current.selections.find((row) => row.projectPath === input.projectPath)?.id !== expectedSelectionId) {
        throw new Error('Skill selection changed; review it again')
      }
      const selected = selectionSchema.parse({ ...input, id: randomUUID(), revision: source.revision, selectedAt: new Date().toISOString(),
        counts: { skills: source.skills.length, commands: source.commands.length, agents: source.agents.length, excluded: source.excluded.length } })
      write({ version: 1, revision: current.revision + 1,
        selections: [...current.selections.filter((row) => row.projectPath !== input.projectPath), selected] })
      return selected
    },
    revoke(projectPath, expectedSelectionId) {
      const current = read()
      const selected = current.selections.find((row) => row.projectPath === projectPath)
      if (!selected) return false
      if (selected.id !== expectedSelectionId) throw new Error('Skill selection changed; review it again')
      write({ version: 1, revision: current.revision + 1, selections: current.selections.filter((row) => row.projectPath !== projectPath) })
      return true
    },
  }
}

export interface SkillLaunch {
  /** Private plugin folder for --plugin-dir. */
  readonly pluginDir: string
  readonly selectionId: string
  readonly validate: () => void
}
export type SkillProvider = (input: { readonly projectPath: string; readonly accountId: string; readonly accountGeneration: number }) => SkillLaunch | undefined

const CHANGED = 'Your skills, commands or agents changed since they were chosen for this project. Review them again in Project Settings.'

export function createSkillProvider(options: { readonly selections: SkillSelectionStore; readonly projectionRoot: string }): SkillProvider {
  return (input) => {
    const selected = options.selections.get(input.projectPath)
    // Chosen for another account: not this conversation's to load, and not a reason to stop it.
    if (!selected || selected.destinationAccountId !== input.accountId) return undefined
    if (selected.destinationGeneration !== input.accountGeneration) throw new Error('Skill selection belongs to a different account generation')
    let source: ReturnType<typeof snapshotSkillSource>
    try { source = snapshotSkillSource(selected.sourceProfileDir) } catch { throw new Error('Your skills could not be read. Review them again in Project Settings.') }
    if (source.revision !== selected.revision) throw new Error(CHANGED)
    const pluginDir = materializeSkillProjection(source, options.projectionRoot)
    return {
      pluginDir,
      selectionId: selected.id,
      validate: () => {
        const current = options.selections.get(input.projectPath)
        if (current?.id !== selected.id) throw new Error('Skill selection changed. Start the conversation again to use the current choice.')
        if (snapshotSkillSource(selected.sourceProfileDir).revision !== selected.revision) throw new Error(CHANGED)
      },
    }
  }
}
