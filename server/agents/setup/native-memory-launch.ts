// Resolves a conversation's selected native memory into the private overlay its Claude session loads.
// The source is never handed to the provider: only a reviewed revision's copy, kept per conversation
// and selection so the provider's own memory writes survive later and resumed sessions.
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { materializeNativeMemory } from './memory-overlay.ts'
import type { NativeMemoryScope, NativeMemorySelection, NativeMemorySelectionStore } from './native-memory-selection.ts'

export interface NativeMemoryLaunchInput {
  readonly threadId: string
  readonly projectPath: string
  readonly workspaceId?: string
  readonly accountId: string
  readonly accountGeneration: number
}
export interface NativeMemoryLaunch {
  /** Private overlay folder for the provider's autoMemoryDirectory. */
  readonly directory: string
  readonly selectionId: string
  /** Rechecks the selection and its source immediately before provider startup and each later input. */
  readonly validate: () => void
}
/** Throws when a selection exists but cannot be used: the launch must stop rather than run without it. */
export type NativeMemoryProvider = (input: NativeMemoryLaunchInput) => NativeMemoryLaunch | undefined

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Most specific first, and explicit: a thread choice, then the workspace's, then the project's. */
export function nativeMemoryScopes(input: Pick<NativeMemoryLaunchInput, 'threadId' | 'projectPath' | 'workspaceId'>): NativeMemoryScope[] {
  return [
    ...(UUID.test(input.threadId) ? [{ projectPath: input.projectPath, threadId: input.threadId }] : []),
    ...(input.workspaceId ? [{ projectPath: input.projectPath, workspaceId: input.workspaceId }] : []),
    { projectPath: input.projectPath },
  ]
}

/** The one private overlay already made for this conversation and selection, if it is intact. */
function existingOverlay(root: string): string | undefined {
  let names: string[]
  try { names = readdirSync(root).filter((name) => name.startsWith('memory-')) } catch { return undefined }
  if (names.length !== 1) {
    if (names.length > 1) throw new Error('Native memory overlay is ambiguous; it was not reused')
    return undefined
  }
  const dir = join(root, names[0]!)
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Native memory overlay is not private')
  return dir
}

export function createNativeMemoryProvider(options: { readonly selections: NativeMemorySelectionStore; readonly overlayRoot: string }): NativeMemoryProvider {
  return (input) => {
    let selection: NativeMemorySelection | undefined
    let scope: NativeMemoryScope | undefined
    for (const candidate of nativeMemoryScopes(input)) {
      // Chosen for another account: not this conversation's memory, and not a reason to stop it. The same
      // account at another generation is a changed identity, and validate refuses it.
      const recorded = options.selections.get(candidate)
      if (!recorded || recorded.destinationAccountId !== input.accountId) continue
      selection = options.selections.validate(candidate, input.accountId, input.accountGeneration)
      if (selection) { scope = candidate; break }
    }
    if (!selection || !scope) return undefined
    const chosen = selection, chosenScope = scope
    if (!UUID.test(input.threadId)) throw new Error('Native memory needs a conversation identity')
    const root = join(options.overlayRoot, input.threadId, chosen.id)
    const directory = existingOverlay(root) ?? materializeNativeMemory(chosen.sourceDir, root, chosen.sourceRevision).directory
    return {
      directory,
      selectionId: chosen.id,
      validate: () => {
        const current = options.selections.validate(chosenScope, input.accountId, input.accountGeneration)
        if (current?.id !== chosen.id) throw new Error('Native memory selection changed. Start the conversation again to use the current choice.')
      },
    }
  }
}
