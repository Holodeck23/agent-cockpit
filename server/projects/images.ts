import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMAGE_KINDS, type ImageExt } from '../files/image-kind.ts'

// A project's picture, kept by the app in <root>/project-images (never in the project folder).
// The page sends a small square it has already scaled down; the server still accepts only PNG, JPEG,
// GIF or WebP up to 512 KB, checked by its bytes as well as its label.
// SVG is refused: it can carry script.

export const MAX_IMAGE_BYTES = 512 * 1024
const TYPES = IMAGE_KINDS
type Ext = ImageExt
const EXT_BY_MIME: Record<string, Ext> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export class ImageError extends Error {}

const dirOf = (root: string): string => join(root, 'project-images')
const prefixOf = (projectPath: string): string => createHash('sha256').update(projectPath).digest('hex').slice(0, 16)

/** Validates a data: URL and stores it; returns the new file name. Older pictures for the project are removed. */
export function saveProjectImage(root: string, projectPath: string, dataUrl: string, now = Date.now()): string {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  const ext = match ? EXT_BY_MIME[match[1]!] : undefined
  if (!match || !ext) throw new ImageError('Choose a PNG, JPEG, GIF or WebP image')
  const bytes = Buffer.from(match[2]!, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new ImageError('Choose an image up to 512 KB')
  if (!TYPES[ext].magic(bytes)) throw new ImageError('That file is not the image type it claims to be')
  const dir = dirOf(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  removeProjectImages(root, projectPath)
  const name = `${prefixOf(projectPath)}-${now}.${ext}`
  writeFileSync(join(dir, name), bytes, { mode: 0o600 })
  return name
}

export function removeProjectImages(root: string, projectPath: string): void {
  const dir = dirOf(root)
  if (!existsSync(dir)) return
  const prefix = `${prefixOf(projectPath)}-`
  for (const file of readdirSync(dir)) if (file.startsWith(prefix)) rmSync(join(dir, file), { force: true })
}

/** The stored picture for a file name the project store holds, or undefined. */
export function readProjectImage(root: string, name: string): { bytes: Buffer; mime: string } | undefined {
  const ext = /\.(png|jpg|gif|webp)$/.exec(name)?.[1] as Ext | undefined
  const file = join(dirOf(root), name)
  if (!ext || name.includes('/') || !existsSync(file)) return undefined
  return { bytes: readFileSync(file), mime: TYPES[ext].mime }
}
