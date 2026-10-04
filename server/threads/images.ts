import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMAGE_KINDS, sniffImage, type ImageExt } from '../files/image-kind.ts'

// Images in a conversation (ones you attach, ones the agent shows), kept by the app:
//   <root>/attachments/<threadId>/<sha256>.<ext>
// Never in the project folder, never as base64 in the event log. Named by content, so the
// same picture twice is one file and a name can't be guessed or chosen by whoever sent it.

/** Claude's API limit per image, so a stored image can always be sent on. */
export const MAX_ATTACHED_IMAGE_BYTES = 5 * 1024 * 1024
/** The only names the store writes, and so the only names it serves. */
export const IMAGE_FILE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/

const THREAD_ID = /^[0-9a-f-]{36}$/

/** An image you can fix (wrong type, too big). Maps to HTTP 400. */
export class ImageAttachError extends Error {}

export interface StoredImage {
  readonly file: string
  readonly mediaType: string
  /** Where it is on disk, for agents that read the file themselves. */
  readonly path: string
}

export interface ImageStore {
  /** The conversation's image folder (Antigravity is given read access to it). */
  dir(threadId: string): string
  save(threadId: string, bytes: Buffer): StoredImage
  read(threadId: string, file: string): { readonly bytes: Buffer; readonly mediaType: string } | undefined
  remove(threadId: string): void
}

export function createImageStore(root: string): ImageStore {
  const dir = (threadId: string): string => {
    if (!THREAD_ID.test(threadId)) throw new Error(`Invalid thread id: ${threadId}`)
    return join(root, 'attachments', threadId)
  }
  return {
    dir,
    save(threadId, bytes) {
      if (bytes.length > MAX_ATTACHED_IMAGE_BYTES) throw new ImageAttachError('Images can be up to 5 MB each')
      const kind = bytes.length > 0 ? sniffImage(bytes) : undefined
      if (!kind) throw new ImageAttachError('Attach a PNG, JPEG, GIF or WebP image')
      const folder = dir(threadId)
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const file = `${createHash('sha256').update(bytes).digest('hex')}.${kind.ext}`
      const path = join(folder, file)
      if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 })
      return { file, mediaType: kind.mime, path }
    },
    read(threadId, file) {
      const path = join(dir(threadId), file)
      if (!IMAGE_FILE.test(file) || !existsSync(path)) return undefined
      const ext = file.slice(file.lastIndexOf('.') + 1) as ImageExt
      return { bytes: readFileSync(path), mediaType: IMAGE_KINDS[ext].mime }
    },
    remove(threadId) {
      rmSync(dir(threadId), { recursive: true, force: true })
    },
  }
}
