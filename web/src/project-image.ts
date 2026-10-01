// Turns a chosen picture into the small square the server stores (128 px, centre-cropped PNG),
// so any photo fits the upload limit and every avatar looks the same.
export const AVATAR_PX = 128

export async function avatarDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture Cockpit can read. Choose a PNG, JPEG, GIF or WebP image.')
  })
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_PX
    canvas.height = AVATAR_PX
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This window cannot draw images')
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX)
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}

/** Where the page loads a project's picture; the file name changes with every new picture. */
export const projectImageUrl = (path: string, image: string): string =>
  `/api/projects/image?path=${encodeURIComponent(path)}&v=${encodeURIComponent(image)}`
