import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type FileMatch, type Workflow } from '../api.ts'
import { fileReference, tokenFor, type ReferenceKind } from '../draft-references.ts'
import { focusComposer } from '../focus-composer.ts'
import { usePopover } from '../usePopover.ts'
import { displayTitle } from '../workflow-list.ts'
import { FileIcon, PlusIcon, WorkflowIcon } from './icons.tsx'

interface Option { kind: ReferenceKind; token: string; title: string; detail?: string }

interface ContextPickerProps {
  projectPath: string
  /** Tokens already in the draft, shown as added. */
  attached: ReadonlySet<string>
  filesFull: boolean
  onPick: (token: string) => void
  onBrowseFiles?: () => void
}

/** The composer's "+": search this project's files and workflows and add them to the message. */
export function ContextPicker({ projectPath, attached, filesFull, onPick, onBrowseFiles }: ContextPickerProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>({ onEscape: () => focusComposer(ref.current) })
  const [query, setQuery] = useState('')
  // Results remember their query: Enter must never pick a row left over from earlier typing.
  const [files, setFiles] = useState<{ query: string; matches: FileMatch[]; truncated: boolean }>({ query: '', matches: [], truncated: false })
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    api.listWorkflows(projectPath).then((rows) => { if (live) setWorkflows(rows) }, () => { if (live) setWorkflows([]) })
    input.current?.focus()
    return () => { live = false }
  }, [open, projectPath])

  useEffect(() => {
    if (!open) return
    let live = true
    const timer = setTimeout(() => {
      api.searchFiles(projectPath, query).then(
        (result) => { if (live) { setFiles({ query, ...result }); setError('') } },
        (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) },
      )
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [open, projectPath, query])

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const current = files.query === query ? files : { matches: [], truncated: false }
  const flows = workflows.filter((w) => words.every((word) => `${w.name} ${w.title ?? ''}`.toLowerCase().includes(word))).slice(0, 8)
  const options: Option[] = [
    ...current.matches.map((f): Option => ({ kind: 'file', token: tokenFor('file', fileReference(f.path)), title: f.name, detail: f.path })),
    ...flows.map((w): Option => ({ kind: 'workflow', token: tokenFor('workflow', w.name), title: displayTitle(w), detail: w.name })),
  ]
  const disabled = (o: Option): boolean => attached.has(o.token) || (o.kind === 'file' && filesFull)
  // Stays open so several files and workflows can be added in a row; Escape returns to the message.
  const pick = (o: Option | undefined): void => {
    if (!o || disabled(o)) return
    onPick(o.token)
    input.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (options.length ? (i + step + options.length) % options.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(options[active])
    }
  }
  const row = (o: Option, index: number) => (
    <button key={o.token} type="button" role="option" aria-selected={index === active} disabled={disabled(o)}
      className={`picker-row${index === active ? ' active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => pick(o)}>
      {o.kind === 'file' ? <FileIcon /> : <WorkflowIcon />}
      <span className="picker-title">{o.title}</span>
      <span className="picker-detail">{attached.has(o.token) ? 'Added' : o.kind === 'file' && filesFull ? 'Limit reached' : o.detail}</span>
    </button>
  )

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="icon-button" aria-label="Add context" title="Add files or workflows" aria-expanded={open}
        onClick={() => { setOpen(!open); setActive(0) }}>
        <PlusIcon />
      </button>
      {open ? (
        <div className="picker-panel" role="dialog" aria-label="Add context">
          <input ref={input} aria-label="Search files and workflows" placeholder="Search files and workflows…" value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
          {error ? <p className="picker-note" role="alert">{error}</p> : null}
          <div role="listbox" aria-label="Files and workflows" className="picker-list">
            {current.matches.length ? <p className="picker-heading">Files</p> : null}
            {options.filter((o) => o.kind === 'file').map((o, i) => row(o, i))}
            {current.truncated ? <p className="picker-note">More files match; keep typing to narrow the list.</p> : null}
            {flows.length ? <p className="picker-heading">Workflows</p> : null}
            {options.filter((o) => o.kind === 'workflow').map((o, i) => row(o, current.matches.length + i))}
            {options.length === 0 && !error && files.query === query ? <p className="picker-note">Nothing matches “{query}”.</p> : null}
          </div>
          {filesFull ? <p className="picker-note">A message can attach up to 8 files.</p> : null}
          <p className="picker-note picker-hint">Add as many as you need. Esc returns to your message.</p>
          {onBrowseFiles ? <button type="button" className="picker-browse" onClick={() => { setOpen(false); onBrowseFiles() }}>Browse the Files panel…</button> : null}
        </div>
      ) : null}
    </div>
  )
}
