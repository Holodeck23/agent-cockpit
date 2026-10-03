import { useEffect, useState } from 'react'
import { api, type FileMatch, type Workflow } from './api.ts'
import { fileReference, tokenFor, type ReferenceKind } from './draft-references.ts'
import { displayTitle } from './workflow-list.ts'

export interface ReferenceOption { kind: ReferenceKind; token: string; title: string; detail?: string }

export interface ReferenceSearch {
  /** Files first, then workflows: the order the list shows and the arrow keys walk. */
  options: ReferenceOption[]
  truncated: boolean
  error: string
  /** The results are for this query (not left over from earlier typing). */
  settled: boolean
}

/**
 * This project's files and workflows matching `query`, for the composer's "+" picker and its
 * inline @ list. Searches only while `active`; workflows are read once each time it turns on.
 */
export function useReferenceSearch(projectPath: string, query: string, active: boolean): ReferenceSearch {
  // Results remember their query: Enter must never pick a row left over from earlier typing.
  const [files, setFiles] = useState<{ query: string; matches: FileMatch[]; truncated: boolean }>({ query: '', matches: [], truncated: false })
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!active) return
    let live = true
    api.listWorkflows(projectPath).then((rows) => { if (live) setWorkflows(rows) }, () => { if (live) setWorkflows([]) })
    return () => { live = false }
  }, [active, projectPath])

  useEffect(() => {
    if (!active) return
    let live = true
    const timer = setTimeout(() => {
      api.searchFiles(projectPath, query).then(
        (result) => { if (live) { setFiles({ query, ...result }); setError('') } },
        (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) },
      )
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [active, projectPath, query])

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const settled = files.query === query
  const current = settled ? files : { matches: [], truncated: false }
  const flows = workflows.filter((w) => words.every((word) => `${w.name} ${w.title ?? ''}`.toLowerCase().includes(word))).slice(0, 8)
  const options: ReferenceOption[] = [
    ...current.matches.map((f): ReferenceOption => ({ kind: 'file', token: tokenFor('file', fileReference(f.path)), title: f.name, detail: f.path })),
    ...flows.map((w): ReferenceOption => ({ kind: 'workflow', token: tokenFor('workflow', w.name), title: displayTitle(w), detail: w.name })),
  ]
  return { options, truncated: current.truncated, error, settled }
}
