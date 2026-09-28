import { useEffect, useState } from 'react'
import { api, type Workflow } from '../api.ts'

export function WorkflowMention({ projectPath, onInsert }: { projectPath: string; onInsert: (name: string) => void }) {
  const [rows, setRows] = useState<Workflow[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    api.listWorkflows(projectPath).then((rows) => { if (active) setRows(rows) }, () => { if (active) setError(true) })
    return () => { active = false }
  }, [projectPath])
  return <select className="workflow-mention" aria-label="Insert workflow" value=""
    title={error ? 'Could not load workflows; reopen this conversation to retry' : 'Insert saved instructions'}
    onChange={(e) => { if (e.target.value) onInsert(e.target.value) }}>
    <option value="">@ Workflow</option>
    {rows.length === 0 ? <option disabled>{error ? 'Workflows unavailable' : 'Save one in Workflows first'}</option> : null}
    {rows.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
  </select>
}
