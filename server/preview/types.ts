/** A preview belongs to the conversation/workspace that asked to open it (W7.3). */
export interface PreviewOpen {
  readonly url: string
  readonly projectPath: string
  /** The workspace folder the conversation works in (a worktree's own folder); absent means the project folder. */
  readonly cwd?: string
  readonly workspaceId?: string
  readonly threadId?: string
  /** The desktop host already loaded it in the conversation's own page (W9-11): show it, do not load it again. */
  readonly loaded?: boolean
}

/** inspect_preview's image of the page itself, as the agent receives it. */
export interface PreviewCapture {
  readonly data: string
  readonly mimeType: 'image/png'
  readonly width: number
  readonly height: number
  /** Which page and revision the image shows, when it is the conversation's own page. */
  readonly page?: { readonly pageId: string; readonly revision: number; readonly url: string }
}
