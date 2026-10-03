import type { ReferenceOption } from '../useReferenceSearch.ts'
import { FileIcon, WorkflowIcon } from './icons.tsx'

interface ReferenceListProps {
  options: ReferenceOption[]
  active: number
  attached: ReadonlySet<string>
  filesFull: boolean
  truncated: boolean
  /** Shown when nothing matches; omit while results are still loading. */
  empty?: string
  onActive: (index: number) => void
  onPick: (option: ReferenceOption) => void
}

export const referenceDisabled = (o: ReferenceOption, attached: ReadonlySet<string>, filesFull: boolean): boolean =>
  attached.has(o.token) || (o.kind === 'file' && filesFull)

/** Files and workflows to add to a message, grouped, with the keyboard-active row marked. */
export function ReferenceList({ options, active, attached, filesFull, truncated, empty, onActive, onPick }: ReferenceListProps) {
  const files = options.filter((o) => o.kind === 'file')
  const flows = options.filter((o) => o.kind === 'workflow')
  const row = (o: ReferenceOption, index: number) => (
    <button key={o.token} type="button" role="option" aria-selected={index === active} disabled={referenceDisabled(o, attached, filesFull)}
      className={`picker-row${index === active ? ' active' : ''}`} onMouseEnter={() => onActive(index)}
      // Keeps focus in the message box when the list hangs off it.
      onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(o)}>
      {o.kind === 'file' ? <FileIcon /> : <WorkflowIcon />}
      <span className="picker-title">{o.title}</span>
      <span className="picker-detail">{attached.has(o.token) ? 'Added' : o.kind === 'file' && filesFull ? 'Limit reached' : o.detail}</span>
    </button>
  )
  return (
    <div role="listbox" aria-label="Files and workflows" className="picker-list">
      {files.length ? <p className="picker-heading">Files</p> : null}
      {files.map((o, i) => row(o, i))}
      {truncated ? <p className="picker-note">More files match; keep typing to narrow the list.</p> : null}
      {flows.length ? <p className="picker-heading">Workflows</p> : null}
      {flows.map((o, i) => row(o, files.length + i))}
      {options.length === 0 && empty ? <p className="picker-note">{empty}</p> : null}
    </div>
  )
}
