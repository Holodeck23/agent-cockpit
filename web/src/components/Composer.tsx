import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { MAX_ATTACHED_FILES } from '../../../server/files/references.ts'
import { addReference, referencesIn, removeReference, tokenFor } from '../draft-references.ts'
import { BranchPicker } from './BranchPicker.tsx'
import { ContextPicker } from './ContextPicker.tsx'
import { useMentionMenu } from './MentionMenu.tsx'
import { ReferenceChips } from './ReferenceChips.tsx'
import { ArrowUpIcon } from './icons.tsx'

interface ComposerProps {
  /** Drafts are kept per conversation in localStorage and survive reloads. */
  onBrowseFiles?: () => void
  initialDraft?: string
  onDraftLoaded?: () => void
  /** Replaces the draft and focuses the box, e.g. from a starter suggestion. A new object each time. */
  /** Fills the message box; with `reference`, adds that token to what is already typed instead. */
  prefill?: { readonly text: string; readonly reference?: boolean; readonly restore?: boolean }
  projectPath?: string
  /** Set in a conversation (not on New conversation). */
  threadId?: string
  draftKey: string
  placeholder: string
  disabled?: boolean
  /** The agent picker, shown in the bottom row. */
  picker: ReactNode
  /** Re-reads the branch pill when it changes, e.g. the conversation's status. */
  branchRefreshKey?: string
  onSubmit: (text: string) => Promise<void>
}

const MAX_HEIGHT = 220
// macOS inline predictions put a guessed word in the box, and Enter accepts the guess
// instead of sending. A prompt should hold only what the person typed.
const NO_WRITING_SUGGESTIONS: Record<string, string> = { writingsuggestions: 'false' }

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

export function Composer({ onBrowseFiles, initialDraft, onDraftLoaded, prefill, projectPath, threadId, draftKey, placeholder, disabled, picker, branchRefreshKey, onSubmit }: ComposerProps) {
  const [text, setText] = useState(() => loadDraft(draftKey))
  const [sending, setSending] = useState(false)
  const [submitError, setSubmitError] = useState<string>()
  // Where the caret is while the box has focus; drives the inline @ list.
  const [caret, setCaret] = useState<number>()
  const pendingCaret = useRef<number | undefined>(undefined)
  const box = useRef<HTMLTextAreaElement>(null)
  const appliedDraft = useRef<string | undefined>(undefined)

  useEffect(() => {
    const saved = loadDraft(draftKey)
    const shouldAppend = initialDraft && appliedDraft.current !== initialDraft
    const next = shouldAppend ? `${saved}${saved ? '\n' : ''}${initialDraft} ` : saved
    setText(next)
    if (shouldAppend) { appliedDraft.current = initialDraft; saveDraft(draftKey, next); onDraftLoaded?.() }
  }, [draftKey, initialDraft, onDraftLoaded])

  useEffect(() => {
    if (!prefill) return
    const current = box.current?.value ?? ''
    // A restored message goes above whatever you have typed since, never over it.
    const next = prefill.reference ? addReference(current, prefill.text) : prefill.restore && current.trim() ? `${prefill.text}\n${current}` : prefill.text
    setText(next)
    saveDraft(draftKey, next)
    const el = box.current
    if (el) { el.focus(); requestAnimationFrame(() => el.setSelectionRange(next.length, next.length)) }
    // Only a new prefill applies; draftKey is read at that moment.
  }, [prefill])

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    if (pendingCaret.current !== undefined) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      setCaret(pendingCaret.current)
      pendingCaret.current = undefined
    }
  }, [text])

  const update = (value: string): void => {
    setText(value)
    // A send error is about the text that was sent; editing moves on from it.
    setSubmitError(undefined)
    saveDraft(draftKey, value)
  }

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || sending || disabled) return
    setSending(true)
    setSubmitError(undefined)
    try {
      await onSubmit(trimmed)
      update('')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const references = referencesIn(text)
  const attached = new Set(references.map((r) => tokenFor(r.kind, r.reference)))
  const filesAttached = references.filter((r) => r.kind === 'file').reduce((n, r) => n + r.count, 0)
  const filesFull = filesAttached >= MAX_ATTACHED_FILES
  const mentions = useMentionMenu({
    projectPath, text, caret, attached, filesFull,
    onComplete: (next, at) => { pendingCaret.current = at; update(next) },
  })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentions.onKeyDown(event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) void submit(event)
  }

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      {submitError ? <p className="workflow-notice" role="alert">{submitError}</p> : null}
      <div className="composer-card">
        {mentions.menu}
        <ReferenceChips projectPath={projectPath} text={text} onRemove={(token) => { update(removeReference(text, token)); box.current?.focus() }} />
        <div className="composer-top">
          <textarea
            ref={box}
            value={text}
            placeholder={placeholder}
            aria-label="Message"
            rows={1}
            {...NO_WRITING_SUGGESTIONS}
            disabled={disabled}
            onChange={(e) => { update(e.target.value); setCaret(e.target.selectionStart) }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={(e) => setCaret(e.currentTarget.selectionStart)}
            onBlur={() => setCaret(undefined)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="composer-foot">
          {projectPath ? (
            <ContextPicker projectPath={projectPath} attached={attached} filesFull={filesFull}
              onBrowseFiles={onBrowseFiles} onPick={(token) => { update(addReference(text, token)); box.current?.focus() }} />
          ) : null}
          {picker}
          {projectPath ? <BranchPicker projectPath={projectPath} threadId={threadId} refreshKey={branchRefreshKey} /> : null}
          <span className="composer-spacer" />
          <button type="submit" className="send" aria-label="Send" disabled={disabled || sending || !text.trim()}>
            <ArrowUpIcon />
          </button>
        </div>
      </div>
    </form>
  )
}
