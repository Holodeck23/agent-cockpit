import type { PreviewState, PreviewTicket } from '../../server/remote/preview/control.ts'

// View app on the phone (W11.2/W11.3): ask the control origin for a one-use ticket for one running
// process, then post it to that app's own preview origin in a tab of its own. Asking again never
// starts the app or changes Tailscale; it only asks for another ticket.

/** What the phone shows after asking: each has its own words and a way back to the conversation. */
export type ViewOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: PreviewState | 'revoked' | 'disconnected' | 'failed'; readonly message: string }

export const OUTCOME_TITLE: Record<Exclude<ViewOutcome['kind'], 'opened'>, string> = {
  stopped: 'The app is not running',
  'not-enabled': 'Not turned on for the phone',
  'phone-off': 'Phone access is off',
  'no-local-url': 'Nothing to open',
  revoked: 'This phone is signed out',
  disconnected: 'Can’t reach your Mac',
  failed: 'Could not open the app',
}

/** Asks for a ticket. Never throws: a network failure is the disconnected state. */
export async function requestTicket(processId: string, fetcher: typeof fetch = fetch): Promise<PreviewTicket | Exclude<ViewOutcome, { kind: 'opened' }>> {
  let response: Response
  try {
    response = await fetcher('/api/phone/preview-tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ processId }) })
  } catch {
    return { kind: 'disconnected', message: 'Check that Tailscale is connected on this phone and that Cockpit is open on your Mac, then try again.' }
  }
  const payload = (await response.json().catch(() => ({}))) as { data?: PreviewTicket; error?: string; state?: PreviewState }
  if (response.status === 201 && payload.data) return payload.data
  if (response.status === 401) return { kind: 'revoked', message: 'This phone’s access was removed on your Mac. Pair it again from Cockpit.' }
  if (payload.state) return { kind: payload.state, message: payload.error ?? '' }
  return { kind: 'failed', message: payload.error ?? `Cockpit answered ${response.status}.` }
}

/**
 * Posts the ticket to the app's bootstrap in its own named tab. The ticket travels only in this
 * form body (never a URL), and noopener keeps the app's page from steering this one. Not
 * noreferrer: under it Chrome sends `Origin: null`, and the bootstrap accepts only the control
 * Origin (the page's own policy is strict-origin for the same reason).
 */
export function postTicket(ticket: PreviewTicket, doc: Document = document): void {
  const form = doc.createElement('form')
  form.method = 'POST'
  form.action = ticket.bootstrap
  form.target = ticket.target
  form.setAttribute('rel', 'noopener')
  form.hidden = true
  const input = doc.createElement('input')
  input.type = 'hidden'
  input.name = 'ticket'
  input.value = ticket.ticket
  form.append(input)
  doc.body.append(form)
  try { form.submit() } finally { form.remove() }
}
