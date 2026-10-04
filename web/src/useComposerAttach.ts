import { useState, type ClipboardEvent, type DragEvent } from 'react'
import { planDrop, type DroppedItem } from './composer-drop.ts'
import { native } from './native.ts'

// Images, files and folders dropped on or pasted into the composer (I1). Images wait as chips
// until the message is sent; files and folders go into the text (see composer-drop.ts).

export interface PendingImage {
  readonly id: string
  readonly name: string
  /** Base64, as the server takes it; absent for an image the conversation already holds. */
  readonly data?: string
  /** That held image's stored name (a taken-back message's images, R8): it is sent by name. */
  readonly stored?: string
  /** A data: URL of the same bytes, or the conversation's image URL, for the chip's thumbnail. */
  readonly url: string
}

/** What the server takes for one chip: its bytes, or its stored name in this conversation. */
export function chipToSend({ data, stored, name }: PendingImage): { data: string; name: string } | { stored: string; name: string } {
  return stored ? { stored, name } : { data: data ?? '', name }
}

const hasFiles = (types: readonly string[]): boolean => types.includes('Files')

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ id: crypto.randomUUID(), name: file.name || 'image', data: url.slice(url.indexOf(',') + 1), url })
    }
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export function useComposerAttach({ projectPath, onInsert }: { projectPath?: string; onInsert: (pieces: readonly string[]) => void }) {
  const [images, setImages] = useState<readonly PendingImage[]>([])
  const [note, setNote] = useState<string>()
  const [dragging, setDragging] = useState(false)

  const take = (files: readonly File[], directories: readonly boolean[]): void => {
    const items: DroppedItem[] = files.map((file, i) => {
      const path = native?.pathForFile(file)
      return { name: file.name, type: file.type, size: file.size, directory: directories[i] ?? false, ...(path ? { path } : {}) }
    })
    const plan = planDrop(items, projectPath, images.length)
    if (plan.insert.length) onInsert(plan.insert)
    setNote(plan.notes.length ? plan.notes.join(' ') : undefined)
    void Promise.all(plan.images.map((i) => readImage(files[i]!))).then(
      (read) => setImages((current) => [...current, ...read]),
      (error: unknown) => setNote(error instanceof Error ? error.message : String(error)),
    )
  }

  return {
    images,
    note,
    dragging,
    remove: (id: string) => setImages((current) => current.filter((image) => image.id !== id)),
    clear: () => { setImages([]); setNote(undefined) },
    /** Puts back the images of a message you took back, as chips that send them by name. */
    restore: (threadId: string, held: readonly { file: string; name?: string }[]) => setImages((current) => [...current,
      ...held.map(({ file, name }) => ({ id: crypto.randomUUID(), name: name ?? 'image', stored: file, url: `/api/threads/${threadId}/images/${file}` }))]),
    dropProps: {
      onDragOver: (event: DragEvent) => {
        if (!hasFiles(Array.from(event.dataTransfer.types))) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) },
      onDrop: (event: DragEvent) => {
        if (!hasFiles(Array.from(event.dataTransfer.types))) return
        event.preventDefault()
        setDragging(false)
        // Which drops are folders can only be read during the drop event itself.
        const entries = Array.from(event.dataTransfer.items).filter((i) => i.kind === 'file')
        take(Array.from(event.dataTransfer.files), entries.map((i) => i.webkitGetAsEntry()?.isDirectory === true))
      },
    },
    onPaste: (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData.files)
      if (files.length === 0) return
      // Pasted files are taken over; pasted text stays a normal paste.
      event.preventDefault()
      take(files, files.map(() => false))
    },
  }
}
