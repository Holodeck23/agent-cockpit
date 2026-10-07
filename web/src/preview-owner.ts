import type { PreviewOpen } from '../../server/preview/types.ts'
import type { ProcessInfo } from './api.ts'

export type PreviewMap = Readonly<Record<string, string>>

/** Conversation previews are independent; project processes use the workspace-level slot. */
export const previewKey = (preview: Pick<PreviewOpen, 'threadId' | 'projectPath' | 'cwd'>): string =>
  preview.threadId ? `thread:${preview.threadId}` : `project:${preview.cwd ?? preview.projectPath}`

export const previewUrl = (previews: PreviewMap, target: Pick<PreviewOpen, 'threadId' | 'projectPath' | 'cwd'> | undefined): string | undefined =>
  target ? previews[previewKey(target)] : undefined

export const rememberPreview = (previews: PreviewMap, preview: PreviewOpen): PreviewMap =>
  ({ ...previews, [previewKey(preview)]: preview.url })

export const forgetPreview = (previews: PreviewMap, target: Pick<PreviewOpen, 'threadId' | 'projectPath' | 'cwd'>): PreviewMap => {
  const next = { ...previews }
  delete next[previewKey(target)]
  return next
}

export function processPreview(info: ProcessInfo): PreviewOpen | undefined {
  if (!info.url || info.status === 'exited') return undefined
  return {
    url: info.url,
    projectPath: info.projectPath,
    // A worktree's process: its page and website data live with that folder.
    ...(info.cwd !== info.projectPath ? { cwd: info.cwd } : {}),
    ...(info.owner.kind === 'conversation' ? { threadId: info.owner.threadId } : {}),
  }
}
