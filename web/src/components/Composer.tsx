import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'

interface ComposerProps {
  /** Drafts are kept per thread in localStorage and survive reloads. */
  draftKey: string
  placeholder: string
  disabled?: boolean
  onSubmit: (text: string) => Promise<void>
}

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

export function Composer({ draftKey, placeholder, disabled, onSubmit }: ComposerProps) {
  const [text, setText] = useState(() => loadDraft(draftKey))
  const [sending, setSending] = useState(false)

  useEffect(() => {
    setText(loadDraft(draftKey))
  }, [draftKey])

  const update = (value: string): void => {
    setText(value)
    saveDraft(draftKey, value)
  }

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await onSubmit(trimmed)
      update('')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) void submit(event)
  }

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <textarea
        value={text}
        placeholder={placeholder}
        rows={3}
        disabled={disabled}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="primary" disabled={disabled || sending || !text.trim()}>
        Send
      </button>
    </form>
  )
}
