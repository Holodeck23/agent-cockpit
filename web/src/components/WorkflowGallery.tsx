import { useEffect, useMemo, useRef, useState } from 'react'
import { GALLERY, type GalleryWorkflow } from '../gallery/catalog.ts'
import { categoryCounts, featured, findGallery, inCategory, needsSentence, relatedTo, scheduleLabel, searchGallery, type CategoryFilter } from '../gallery/gallery.ts'
import { PERMISSION_LABEL } from './AgentPicker.tsx'
import { ChevronLeftIcon, FileIcon, SearchIcon, SidebarIcon } from './icons.tsx'

interface GalleryProps {
  projectName: string
  /** Reference names already in the project, to mark what was added before. */
  taken: ReadonlySet<string>
  busy: boolean
  onAdd: (entry: GalleryWorkflow) => void
  onClose: () => void
  listToggle?: { readonly hidden: boolean; readonly toggle: () => void }
}

export function WorkflowGallery({ projectName, taken, busy, onAdd, onClose, listToggle }: GalleryProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('All')
  const [open, setOpen] = useState<string>()
  const pane = useRef<HTMLElement>(null)
  // Opening a workflow (or going back) starts at the top, not wherever the last view was scrolled.
  useEffect(() => { pane.current?.scrollTo({ top: 0 }) }, [open])
  const matches = useMemo(() => searchGallery(query), [query])
  const shown = inCategory(matches, category)
  const entry = open ? findGallery(open) : undefined
  const card = (w: GalleryWorkflow, size: 'large' | 'small' = 'small') => (
    <button key={w.name} type="button" className={`gallery-card ${size}`} onClick={() => setOpen(w.name)}>
      <span className="gallery-card-category">{w.category}</span>
      <strong>{w.title}</strong>
      <span>{w.summary}</span>
      <small>
        <span>{scheduleLabel(w)}</span>
        {w.needs?.map((tool) => <span key={tool} className="gallery-tool">{tool}</span>)}
        {taken.has(w.name) ? <span className="gallery-added">Added</span> : null}
      </small>
    </button>
  )

  if (entry) {
    const added = taken.has(entry.name)
    return (
      <main ref={pane} className="gallery gallery-detail" aria-label={`${entry.title} in the gallery`}>
        <button type="button" className="gallery-back" onClick={() => setOpen(undefined)}><ChevronLeftIcon />Gallery</button>
        <header>
          <div className="workflow-detail-heading">
            {listToggle ? <button type="button" className="workflow-list-toggle" aria-label={listToggle.hidden ? 'Show workflows' : 'Hide workflows'}
              aria-pressed={!listToggle.hidden} onClick={listToggle.toggle}><SidebarIcon /></button> : null}
            <div><span className="workflow-kicker">{entry.category}</span>
              <h1>{entry.title}</h1>
              {listToggle ? <div className="workflow-breadcrumbs"><span>Workflows</span><span aria-hidden="true">›</span><span>Gallery</span></div> : null}
            </div>
          </div>
          <p>{entry.summary}</p>
        </header>
        <dl className="gallery-facts">
          <div><dt>When</dt><dd>{entry.schedule ? `${scheduleLabel(entry)}, suggested` : 'On demand'}</dd></div>
          <div><dt>Permissions</dt><dd>{PERMISSION_LABEL[entry.permissionMode]}</dd></div>
          <div><dt>Works with</dt><dd>{entry.needs ? entry.needs.join(', ') : 'This project’s folder'}</dd></div>
        </dl>
        {entry.needs ? (
          <div className="gallery-needs" role="note">
            <strong>Relies on {needsSentence(entry.needs)}.</strong>
            <span>Cockpit doesn’t provide these. Set them up in your agent first, for example as an MCP server or connector. Without them, the workflow says what is missing and stops.</span>
          </div>
        ) : null}
        <figure className="gallery-file">
          <figcaption><FileIcon />{entry.name}.md</figcaption>
          <pre aria-label="Instructions">{entry.prompt}</pre>
        </figure>
        <div className="gallery-add">
          <button type="button" className="button-primary" disabled={busy} onClick={() => onAdd(entry)}>
            {added ? 'Add another copy' : 'Add to Workflows'}
          </button>
          <p>
            {added ? `Already in ${projectName}. ` : ''}Saves a paused copy in {projectName} that you can edit. It never runs
            {entry.schedule ? ' or schedules itself; the suggested schedule is filled in and stays off until you turn it on.' : ' until you run it.'}
          </p>
        </div>
        <section className="gallery-related" aria-label="Related workflows">
          <h2>Related workflows</h2>
          <div className="gallery-grid">{relatedTo(entry).map((w) => card(w))}</div>
        </section>
      </main>
    )
  }

  const picks = featured(matches)
  return (
    <main ref={pane} className="gallery" aria-label="Workflow gallery">
      <header className="gallery-head">
        {listToggle ? <button type="button" className="workflow-list-toggle" aria-label={listToggle.hidden ? 'Show workflows' : 'Hide workflows'}
          aria-pressed={!listToggle.hidden} onClick={listToggle.toggle}><SidebarIcon /></button> : null}
        <div>
          <span className="workflow-kicker">Workflow gallery</span>
          <h1>Start from a workflow</h1>
          {listToggle ? <div className="workflow-breadcrumbs"><span>Workflows</span><span aria-hidden="true">›</span><span>Gallery</span></div> : null}
          <p>{GALLERY.length} ready-made jobs, most of them for working inside a repository. Adding one copies it into {projectName}, paused: it never runs or schedules itself.</p>
        </div>
        <button type="button" className="button-soft" onClick={onClose}>Close gallery</button>
      </header>
      <label className="workflow-search gallery-search">
        <SearchIcon />
        <input type="search" aria-label="Search the gallery" placeholder="Search the gallery…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="gallery-categories" role="tablist" aria-label="Categories">
        {categoryCounts(matches).map(({ category: c, count }) => (
          <button key={c} type="button" role="tab" aria-selected={category === c} onClick={() => setCategory(c)}>
            {c} <span>{count}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="workflow-none" role="status">Nothing in the gallery matches.</p> : null}
      {category === 'All' && !query && picks.length ? (
        <section className="gallery-section" aria-label="Featured">
          <h2>Featured</h2>
          <div className="gallery-grid featured">{picks.map((w) => card(w, 'large'))}</div>
        </section>
      ) : null}
      {category === 'All'
        ? categoryCounts(shown).slice(1).filter((c) => c.count > 0).map(({ category: c, count }) => (
            <section key={c} className="gallery-section" aria-label={c}>
              <h2>{c} <span>{count}</span></h2>
              <div className="gallery-grid">{inCategory(shown, c).map((w) => card(w))}</div>
            </section>
          ))
        : <div className="gallery-grid">{shown.map((w) => card(w))}</div>}
    </main>
  )
}
