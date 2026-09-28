import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { WorkflowMention } from './WorkflowMention.tsx'
import { ArrowUpIcon, PlusIcon } from './icons.tsx'

interface ComposerProps {
  /** Drafts are kept per conversation in localStorage and survive reloads. */
  projectPath?: string
  draftKey: string
  placeholder: string
  disabled?: boolean
  /** The agent picker, shown in the bottom row. */
  picker: ReactNode
  onSubmit: (text: string) => Promise<void>
}

const MAX_HEIGHT = 220

function loadDraft(key: string): string {
  try {
    return localStorage.getItem(`draft:${key}`) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(`draft:${key}`, text)
    else localStorage.removeItem(`draft:${key}`)
  } catch {
    // storage unavailable: drafts just won't persist
  }
}

export function Composer({ projectPath, draftKey, placeholder, disabled, picker, onSubmit }: ComposerProps) {
  const [text, setText] = useState(() => loadDraft(draftKey))
  const [sending, setSending] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText(loadDraft(draftKey))
  }, [draftKey])

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const update = (value: string): void => {
    setText(value)
    saveDraft(draftKey, value)
  }

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || sending || disabled) return
    setSending(true)
    try {
      await onSubmit(trimmed)
      update('')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) void submit(event)
  }

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <div className="composer-card">
        <div className="composer-top">
          <textarea
            ref={box}
            value={text}
            placeholder={placeholder}
            aria-label="Message"
            rows={1}
            disabled={disabled}
            onChange={(e) => update(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {projectPath ? <WorkflowMention key={projectPath} projectPath={projectPath} onInsert={(name) => {
            update(`${text}${text && !/\s$/.test(text) ? ' ' : ''}@workflow:${name} `)
            box.current?.focus()
          }} /> : null}
        </div>
        <div className="composer-foot">
          <button type="button" className="icon-button" disabled title="Attachments arrive with the Files tab" aria-label="Attach">
            <PlusIcon />
          </button>
          {picker}
          <span className="composer-spacer" />
          <button type="submit" className="send" aria-label="Send" disabled={disabled || sending || !text.trim()}>
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    </form>
  )
}
