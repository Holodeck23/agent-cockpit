// What files dropped on (or pasted into) the composer become (I1). Pure, unit-tested.
//   an image (PNG, JPEG, GIF, WebP)  → a chip; the image goes with the message
//   a file inside the project        → an @file reference, the same as picking it
//   a file outside the project       → its path, typed into the message
//   a folder                         → its path (relative inside the project)
import { fileReferenceToken } from '../../server/files/references.ts'

export const MAX_MESSAGE_IMAGES = 8
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface DroppedItem {
  readonly name: string
  readonly type: string
  readonly size: number
  /** Where it is on disk; only the desktop app knows. */
  readonly path?: string
  readonly directory: boolean
}

export interface DropPlan {
  /** Indexes into the dropped items that become image chips. */
  readonly images: readonly number[]
  /** Tokens and paths to add to the message, in order. */
  readonly insert: readonly string[]
  /** What was left out and why, in plain words. */
  readonly notes: readonly string[]
}

/** A path as the agent should read it: quoted when it has spaces. */
const asText = (path: string): string => (/\s/.test(path) ? `"${path}"` : path)

export function planDrop(items: readonly DroppedItem[], projectPath: string | undefined, imagesAlready: number): DropPlan {
  const images: number[] = []
  const insert: string[] = []
  const notes: string[] = []
  const inside = (path: string): string | undefined =>
    projectPath && path.startsWith(`${projectPath.replace(/\/$/, '')}/`) ? path.slice(projectPath.replace(/\/$/, '').length + 1) : undefined
  items.forEach((item, index) => {
    if (!item.directory && IMAGE_TYPES.has(item.type)) {
      if (item.size > MAX_IMAGE_BYTES) notes.push(`${item.name} is over 5 MB.`)
      else if (imagesAlready + images.length >= MAX_MESSAGE_IMAGES) notes.push(`${item.name} was left out: ${MAX_MESSAGE_IMAGES} images per message.`)
      else images.push(index)
      return
    }
    if (!item.path) {
      notes.push(`${item.name}: only images can be added here; drop files in the Mac app to add their paths.`)
      return
    }
    const relative = inside(item.path)
    if (item.directory) insert.push(asText(relative ?? item.path))
    else insert.push(relative ? fileReferenceToken({ path: relative }) : asText(item.path))
  })
  return { images, insert, notes }
}
