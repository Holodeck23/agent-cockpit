import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from './icons.tsx'

/** Copies a message's text. Shown on hover or keyboard focus of the message; "Copied" for a moment after. */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(id)
  }, [state])
  const copy = (): void => {
    navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'))
  }
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy message'
  return (
    <button type="button" className={`copy-message${state === 'idle' ? '' : ' shown'}`} aria-label={label} title={label} onClick={copy}>
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      {state === 'idle' ? null : <span>{label}</span>}
    </button>
  )
}
