// The image types Cockpit stores and shows, recognised by their bytes, never by a name or label.
// SVG is not one of them: it can carry script.

export const IMAGE_KINDS = {
  png: { mime: 'image/png', magic: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: 'image/gif', magic: (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  webp: { mime: 'image/webp', magic: (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
} as const
export type ImageExt = keyof typeof IMAGE_KINDS

/** The image type these bytes really are, or undefined for anything else. */
export function sniffImage(bytes: Buffer): { readonly ext: ImageExt; readonly mime: string } | undefined {
  for (const ext of Object.keys(IMAGE_KINDS) as ImageExt[]) {
    if (IMAGE_KINDS[ext].magic(bytes)) return { ext, mime: IMAGE_KINDS[ext].mime }
  }
  return undefined
}
