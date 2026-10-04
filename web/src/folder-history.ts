// Back and Forward through the folders shown in Files, like a browser's history.
// Pure, so it is unit-tested; FileTree keeps one per project.

export interface FolderHistory {
  readonly stack: readonly string[]
  readonly index: number
}

export const startHistory = (folder = ''): FolderHistory => ({ stack: [folder], index: 0 })

export const currentFolder = (h: FolderHistory): string => h.stack[h.index] ?? ''

/** Going somewhere new drops anything you could have gone Forward to. Going to where you are changes nothing. */
export function visit(h: FolderHistory, folder: string): FolderHistory {
  if (currentFolder(h) === folder) return h
  const stack = [...h.stack.slice(0, h.index + 1), folder].slice(-100)
  return { stack, index: stack.length - 1 }
}

export const canGoBack = (h: FolderHistory): boolean => h.index > 0
export const canGoForward = (h: FolderHistory): boolean => h.index < h.stack.length - 1
export const back = (h: FolderHistory): FolderHistory => (canGoBack(h) ? { ...h, index: h.index - 1 } : h)
export const forward = (h: FolderHistory): FolderHistory => (canGoForward(h) ? { ...h, index: h.index + 1 } : h)

/** The folder that holds `folder` ("" is the project's top). */
export const parentOf = (folder: string): string => folder.split('/').slice(0, -1).join('/')
