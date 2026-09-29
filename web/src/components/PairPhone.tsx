import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import { Mark } from './icons.tsx'

// First visit from a phone: ask the Mac for approval, show the code to compare,
// and wait. Nothing else is reachable until the Mac says yes.

type Step = { kind: 'idle' } | { kind: 'waiting'; id: string; code: string } | { kind: 'denied' } | { kind: 'expired' } | { kind: 'error'; message: string }

function guessName(): string {
  const ua = navigator.userAgent
  if (/Android/.test(ua)) return 'Android phone'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  return 'Phone'
}

export function PairPhone({ login }: { login: string }) {
  const [name, setName] = useState(guessName)
  const [step, setStep] = useState<Step>({ kind: 'idle' })

  useEffect(() => {
    if (step.kind !== 'waiting') return
    const timer = setInterval(() => {
      api.pairingStatus(step.id).then(
        ({ status }) => {
          if (status === 'approved') window.location.reload()
          else if (status === 'denied') setStep({ kind: 'denied' })
        },
        () => setStep({ kind: 'expired' }),
      )
    }, 2000)
    return () => clearInterval(timer)
  }, [step])

  const ask = (): void => {
    api.requestPairing(name).then(({ id, code }) => setStep({ kind: 'waiting', id, code }),
      (e: unknown) => setStep({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
  }

  return (
    <main className="pair">
      <Mark className="pair-mark" />
      <h1>Connect this phone to Cockpit</h1>
      {step.kind === 'waiting' ? (
        <>
          <p>On your Mac, open Cockpit and allow <b>{name}</b>. Check the Mac shows this code:</p>
          <p className="pair-code" aria-label="Pairing code">{step.code}</p>
          <p className="pair-wait" role="status">Waiting for your Mac…</p>
        </>
      ) : (
        <>
          <p>Signed in to Tailscale as <b>{login}</b>. Your Mac has to approve this phone once.</p>
          <label className="pair-field">
            Name this phone
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          {step.kind === 'denied' ? <p className="pair-error" role="alert">The Mac denied this request.</p> : null}
          {step.kind === 'expired' ? <p className="pair-error" role="alert">The request expired. Ask again.</p> : null}
          {step.kind === 'error' ? <p className="pair-error" role="alert">{step.message}</p> : null}
          <button type="button" className="pair-ask" onClick={ask}>Ask my Mac</button>
        </>
      )}
    </main>
  )
}
