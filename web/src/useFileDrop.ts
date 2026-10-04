import { useState, type DragEvent } from 'react'
import { dropNote } from './drop-note.ts'
import { native } from './native.ts'

// Drop files from Finder onto the Files explorer to copy them into the folder being shown (F8).
// Desktop only: the browser and the phone have no file paths to copy from.

export interface DropResult { readonly copied: readonly string[]; readonly note: string }

const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files')

export function useFileDrop(target: { projectPath: string; space: 'project' | 'documents'; folder: string }, onDone: (result: DropResult) => void, onError: (message: string) => void) {
  const [dragging, setDragging] = useState(false)
  if (!native) return { dragging: false, dropProps: {} }
  return {
    dragging,
    dropProps: {
      onDragOver: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) },
      onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) },
      onDrop: (event: DragEvent) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragging(false)
        const files = Array.from(event.dataTransfer.files)
        native?.copyInto({ ...target, files }).then(
          (result) => { if ('error' in result) onError(result.error); else onDone({ copied: result.copied, note: dropNote(result) }) },
          (e: unknown) => onError(e instanceof Error ? e.message : String(e)),
        )
      },
    },
  }
}
