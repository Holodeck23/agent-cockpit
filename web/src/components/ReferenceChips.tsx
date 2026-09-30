import { useEffect, useState } from 'react'
import { api, type ReferenceCheck } from '../api.ts'
import { referencesIn, tokenFor } from '../draft-references.ts'
import { FileIcon, WorkflowIcon } from './icons.tsx'

/**
 * What the draft will attach, one chip per reference. A reference that would fail if sent
 * now (missing file, unknown workflow) turns red before sending; duplicates are marked.
 */
export function ReferenceChips({ projectPath, text, onRemove }: { projectPath?: string; text: string; onRemove: (token: string) => void }) {
  const references = referencesIn(text)
  const [checks, setChecks] = useState<ReferenceCheck[]>([])
  const signature = references.map((r) => tokenFor(r.kind, r.reference)).join(' ')
  useEffect(() => {
    if (!projectPath || !signature) { setChecks([]); return }
    let live = true
    const check = (): void => {
      api.checkReferences(projectPath, signature).then((rows) => { if (live) setChecks(rows) }, () => { if (live) setChecks([]) })
    }
    const first = setTimeout(check, 250)
    // Files can disappear while the draft waits (the agent may delete one), so keep checking.
    const again = setInterval(check, 4000)
    return () => { live = false; clearTimeout(first); clearInterval(again) }
  }, [projectPath, signature])
  if (references.length === 0) return null
  return (
    <ul className="reference-chips" aria-label="Attached to this message">
      {references.map((r) => {
        const token = tokenFor(r.kind, r.reference)
        const problem = checks.find((c) => c.kind === r.kind && c.reference === r.reference && !c.ok)?.problem
        const name = r.kind === 'file' ? r.label.split('/').pop() ?? r.label : r.label
        return (
          <li key={token} className={`reference-chip${problem ? ' broken' : ''}`} title={problem ?? r.label}>
            {r.kind === 'file' ? <FileIcon /> : <WorkflowIcon />}
            <span>{name}</span>
            {r.count > 1 ? <span className="reference-dup">added {r.count}×</span> : null}
            {problem ? <span className="visually-hidden">{problem}</span> : null}
            <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(token)}>×</button>
          </li>
        )
      })}
    </ul>
  )
}
