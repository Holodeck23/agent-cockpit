// A project's choice to load the user's own skills, commands and agents (W13 U6), bound to the
// destination account generation and the exact revision reviewed. A changed source asks for a fresh
// review instead of loading content nobody looked at; a projection is never edited after it is made.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ensurePrivateDir, writeFileAtomic } from '../../files/atomic.ts'
import { StoreReadError } from '../../state/read-error.ts'
import { listEnabledPlugins, type PluginRef } from './plugin-projection.ts'
import { materializeSkillProjection, projectionPluginDirs, snapshotSkillSource, type SkillLink } from './skill-projection.ts'

const selectionSchema = z.object({
  id: z.uuid(),
  projectPath: z.string().refine(isAbsolute),
  destinationAccountId: z.string().min(1),
  destinationGeneration: z.number().int().min(1),
  sourceAccountId: z.string().min(1),
  sourceProfileDir: z.string().refine(isAbsolute),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.object({ skills: z.number().int().min(0), commands: z.number().int().min(0), agents: z.number().int().min(0), excluded: z.number().int().min(0) }),
  /** Links the user reviewed and included, each with the real folder or file it pointed at then. */
  includedLinks: z.array(z.object({ path: z.string().min(1).max(500), target: z.string().refine(isAbsolute) })).default([]),
  /** Enabled plugins whose skills, commands and agents the user included, each at the folder reviewed. */
  includedPlugins: z.array(z.object({ key: z.string().min(1).max(300), installPath: z.string().refine(isAbsolute) })).default([]),
  selectedAt: z.iso.datetime(),
})
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), selections: z.array(selectionSchema) })
export type SkillSelection = z.output<typeof selectionSchema>

export interface SkillSelectionStore {
  /**
   * `includeLinks` names linked entries (as offered) to include, at the target each points to now;
   * `includePlugins` names enabled plugins by key, at the folder each is installed in now.
   */
  select(input: Pick<SkillSelection, 'projectPath' | 'destinationAccountId' | 'destinationGeneration' | 'sourceAccountId' | 'sourceProfileDir'>
    & { readonly includeLinks?: readonly string[]; readonly includePlugins?: readonly string[] }, expectedSelectionId?: string): SkillSelection
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
    select({ includeLinks = [], includePlugins = [], ...input }, expectedSelectionId) {
      const offered = snapshotSkillSource(input.sourceProfileDir)
      const links: SkillLink[] = [...new Set(includeLinks)].map((path) => {
        const row = offered.excluded.find((entry) => entry.path === path && entry.reason === 'linked')
        if (!row?.includable || !row.target) throw new Error(`${path} is not a link that can be included`)
        return { path, target: row.target }
      })
      const enabled = includePlugins.length ? listEnabledPlugins(input.sourceProfileDir) : []
      const plugins: PluginRef[] = [...new Set(includePlugins)].map((key) => {
        const row = enabled.find((entry) => entry.key === key)
        if (!row || row.problem) throw new Error(`${key} is not an enabled plugin that can be included${row?.problem ? `: ${row.problem}` : ''}`)
        return { key, installPath: row.installPath }
      })
      const source = snapshotSkillSource(input.sourceProfileDir, { links, plugins })
      const current = read()
      if (current.selections.find((row) => row.projectPath === input.projectPath)?.id !== expectedSelectionId) {
        throw new Error('Skill selection changed; review it again')
      }
      const selected = selectionSchema.parse({ ...input, id: randomUUID(), revision: source.revision, selectedAt: new Date().toISOString(), includedLinks: links, includedPlugins: plugins,
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
  /** Private plugin folders for --plugin-dir: the user's own, then each included plugin's copy. */
  readonly pluginDirs: readonly string[]
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
    const inclusions = { links: selected.includedLinks, plugins: selected.includedPlugins }
    try { source = snapshotSkillSource(selected.sourceProfileDir, inclusions) } catch { throw new Error('Your skills could not be read. Review them again in Project Settings.') }
    if (source.revision !== selected.revision) throw new Error(CHANGED)
    const pluginDirs = projectionPluginDirs(source, materializeSkillProjection(source, options.projectionRoot))
    return {
      pluginDirs,
      selectionId: selected.id,
      validate: () => {
        const current = options.selections.get(input.projectPath)
        if (current?.id !== selected.id) throw new Error('Skill selection changed. Start the conversation again to use the current choice.')
        if (snapshotSkillSource(selected.sourceProfileDir, inclusions).revision !== selected.revision) throw new Error(CHANGED)
      },
    }
  }
}
