import type { OutgoingImage } from './types.ts'

// How a message's images reach each agent (I2). Pure: the launchers write what these build.
//   Claude      base64 image blocks before the text (stream-json user message)
//   Codex       localImage items naming the stored file (the client reads it, not a sandboxed tool)
//   ACP         image blocks, only when the agent's initialize advertises promptCapabilities.image
//   otherwise   the stored file's path in the text, for an agent that reads files itself
//               (Antigravity is launched with the conversation's image folder added, so it may)

/** Claude's stream-json user message. */
export function claudeUserMessage(text: string, images: readonly OutgoingImage[] = [], queuedId?: string): Record<string, unknown> {
  const content = [
    ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
    { type: 'text', text },
  ]
  return { type: 'user', ...(queuedId ? { uuid: queuedId } : {}), message: { role: 'user', content } }
}

/** Codex turn/start (and turn/steer) input. */
export function codexInput(text: string, images: readonly OutgoingImage[] = []): Record<string, unknown>[] {
  return [...images.map((image) => ({ type: 'localImage', path: image.path })), { type: 'text', text, text_elements: [] }]
}

/** ACP session/prompt blocks; images inline only for an agent that said it takes them. */
export function acpPrompt(text: string, images: readonly OutgoingImage[] = [], takesImages = false): Record<string, unknown>[] {
  if (!takesImages) return [{ type: 'text', text: withImagePaths(text, images) }]
  return [...images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType })), { type: 'text', text }]
}

/** The message with its images named by path, for an agent that opens them with its own file tools. */
export function withImagePaths(text: string, images: readonly OutgoingImage[] = []): string {
  if (images.length === 0) return text
  const one = images.length === 1
  return `${text}\n\n${one ? 'An image is' : `${images.length} images are`} attached to this message. To see ${one ? 'it' : 'them'}, open:\n${images.map((image) => `- ${image.path}`).join('\n')}`
}
