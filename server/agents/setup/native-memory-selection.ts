// Private host-owned selections. Never send these records or their source paths to the renderer.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic, ensurePrivateDir } from '../../files/atomic.ts'
import { StoreReadError } from '../../state/read-error.ts'
import { snapshotNativeMemory } from './memory-overlay.ts'

const scopeSchema = z.object({
  projectPath: z.string().refine(isAbsolute),
  workspaceId: z.uuid().optional(),
  threadId: z.uuid().optional(),
})
const selectionSchema = z.object({
  id: z.uuid(),
  scope: scopeSchema,
  destinationAccountId: z.string().min(1),
  destinationGeneration: z.number().int().min(1),
  sourceAccountId: z.string().min(1),
  sourceRoot: z.string().refine(isAbsolute),
  sourceDir: z.string().refine(isAbsolute),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().min(1).max(256),
  writePolicy: z.enum(['managed-auto', 'review']),
  selectedAt: z.iso.datetime(),
})
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), selections: z.array(selectionSchema) })
export type NativeMemoryScope = z.output<typeof scopeSchema>
export type NativeMemorySelection = z.output<typeof selectionSchema>

function scopeKey(scope: NativeMemoryScope): string {
  return JSON.stringify([scope.projectPath, scope.workspaceId ?? null, scope.threadId ?? null])
}

function contained(root: string, path: string): boolean {
  const from = relative(root, path)
  return from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
}

function sourceInsideRoot(sourceRoot: string, sourceDir: string): void {
  if (!isAbsolute(sourceRoot) || !isAbsolute(sourceDir)) throw new Error('Native memory source scope is invalid')
  try {
    const rootStat = lstatSync(sourceRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !contained(realpathSync(sourceRoot), realpathSync(sourceDir))) {
      throw new Error('Native memory source leaves its selected scope')
    }
  } catch { throw new Error('Native memory source is unavailable or leaves its selected scope') }
}

export interface NativeMemorySelectionStore {
  /** Persist one exact account/project/workspace/chat selection after source review. */
  select(input: Omit<NativeMemorySelection, 'id' | 'sourceRevision' | 'fileCount' | 'selectedAt'>,
    expectedSelectionId?: string): NativeMemorySelection
  /** Returns only an exact-scope record; callers choose any inheritance explicitly. */
  get(scope: NativeMemoryScope): NativeMemorySelection | undefined
  /** A source/account change fails closed before materialization or subsequent input. */
  validate(scope: NativeMemoryScope, accountId: string, generation: number): NativeMemorySelection | undefined
  revoke(scope: NativeMemoryScope, expectedSelectionId: string): boolean
}

export function createNativeMemorySelectionStore(root: string): NativeMemorySelectionStore {
  const file = join(root, 'native-memory-selections.json')
  const read = (): z.output<typeof fileSchema> => {
    if (!existsSync(file)) return { version: 1, revision: 0, selections: [] }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) }
    catch { throw new StoreReadError('UNREADABLE', file, 'not valid JSON') }
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) throw new StoreReadError('UNREADABLE', file, 'unexpected format')
    return parsed.data
  }
  const write = (next: z.output<typeof fileSchema>): void => {
    ensurePrivateDir(root)
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  // A plain function, not a method: callers may destructure the store.
  const get = (scope: NativeMemoryScope): NativeMemorySelection | undefined => {
    const key = scopeKey(scopeSchema.parse(scope))
    return read().selections.find((row) => scopeKey(row.scope) === key)
  }
  return {
    select(input, expectedSelectionId) {
      const checked = selectionSchema.omit({ id: true, sourceRevision: true, fileCount: true, selectedAt: true }).parse(input)
      if (checked.writePolicy === 'managed-auto' && checked.sourceAccountId !== checked.destinationAccountId) {
        throw new Error('Automatic native memory promotion requires the same account')
      }
      sourceInsideRoot(checked.sourceRoot, checked.sourceDir)
      let source: ReturnType<typeof snapshotNativeMemory>
      try { source = snapshotNativeMemory(checked.sourceDir) }
      catch { throw new Error('Native memory source is unavailable or changed') }
      const current = read()
      const old = current.selections.find((row) => scopeKey(row.scope) === scopeKey(checked.scope))
      if (old?.id !== expectedSelectionId) throw new Error('Native memory selection changed; review it again')
      const selected = selectionSchema.parse({ ...checked, id: randomUUID(), sourceRevision: source.revision,
        fileCount: source.fileCount, selectedAt: new Date().toISOString() })
      write({ version: 1, revision: current.revision + 1,
        selections: [...current.selections.filter((row) => scopeKey(row.scope) !== scopeKey(checked.scope)), selected] })
      return selected
    },
    get,
    validate(scope, accountId, generation) {
      const selected = get(scope)
      if (!selected) return undefined
      if (selected.destinationAccountId !== accountId || selected.destinationGeneration !== generation) {
        throw new Error('Native memory selection belongs to a different account generation')
      }
      sourceInsideRoot(selected.sourceRoot, selected.sourceDir)
      let current: ReturnType<typeof snapshotNativeMemory>
      try { current = snapshotNativeMemory(selected.sourceDir) }
      catch { throw new Error('Native memory source is unavailable or changed') }
      if (current.revision !== selected.sourceRevision || current.fileCount !== selected.fileCount) {
        throw new Error('Native memory source changed after selection')
      }
      return selected
    },
    revoke(scope, expectedSelectionId) {
      const key = scopeKey(scopeSchema.parse(scope))
      const current = read()
      const selected = current.selections.find((row) => scopeKey(row.scope) === key)
      if (!selected) return false
      if (selected.id !== expectedSelectionId) throw new Error('Native memory selection changed; review it again')
      write({ version: 1, revision: current.revision + 1,
        selections: current.selections.filter((row) => scopeKey(row.scope) !== key) })
      return true
    },
  }
}
