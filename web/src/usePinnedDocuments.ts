import { useEffect, useState } from 'react'
import { api } from './api.ts'

// Pinned documents for the navigation. The documents list announces every change it makes,
// so the pins in the navigation follow without a reload.

const CHANGED = 'cockpit:documents-changed'

export const announceDocuments = (): void => { window.dispatchEvent(new Event(CHANGED)) }

/** Names of the project's pinned, unarchived documents, in list order. Empty without a project or on the phone. */
export function usePinnedDocuments(projectPath: string | undefined, enabled: boolean): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([])
  useEffect(() => {
    setNames([])
    if (!projectPath || !enabled) return
    let active = true
    const load = (): void => {
      api.listDocuments(projectPath).then(
        (docs) => { if (active) setNames(docs.filter((d) => d.pinned && !d.archived).map((d) => d.path)) },
        () => { /* the navigation simply shows no document pins */ },
      )
    }
    load()
    window.addEventListener(CHANGED, load)
    return () => { active = false; window.removeEventListener(CHANGED, load) }
  }, [projectPath, enabled])
  return names
}
