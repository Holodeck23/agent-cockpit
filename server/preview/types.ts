/** A preview belongs to the conversation/workspace that asked to open it (W7.3). */
export interface PreviewOpen {
  readonly url: string
  readonly projectPath: string
  readonly threadId?: string
}
