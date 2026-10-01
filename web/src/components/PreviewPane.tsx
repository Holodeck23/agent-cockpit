import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'

const WIDTH_KEY = 'cockpit:preview-width'
const MIN_WIDTH = 360

function initialWidth(): number {
  const saved = Number(localStorage.getItem(WIDTH_KEY))
  return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : 520
}

export function PreviewPane({ url, onClose }: { url: string; onClose: () => void }) {
  const [width, setWidth] = useState(initialWidth)
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { setLoaded(false) }, [url, revision])

  const resize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      const value = Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.72, window.innerWidth - next.clientX))
      setWidth(value)
    }
    const done = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      setWidth((value) => { localStorage.setItem(WIDTH_KEY, String(Math.round(value))); return value })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
  }

  return (
    <aside className="preview-pane" style={{ width }} aria-label="App preview">
      <button type="button" className="preview-resizer" aria-label="Resize preview" onPointerDown={resize} />
      <header className="preview-toolbar">
        <div className="preview-heading">
          <span className={`preview-light${loaded ? ' live' : ''}`} aria-hidden />
          <strong>Preview</strong>
        </div>
        <div className="preview-actions">
          <button type="button" onClick={() => setRevision((value) => value + 1)}>Reload</button>
          <a href={url} target="_blank" rel="noreferrer">Browser ↗</a>
          <button type="button" className="preview-close" aria-label="Close preview" onClick={onClose}>×</button>
        </div>
      </header>
      <div className="preview-address" title={url}><span>Local</span><code>{url}</code></div>
      <iframe key={`${url}:${revision}`} src={url} title={`Preview of ${url}`} onLoad={() => setLoaded(true)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads" />
    </aside>
  )
}
